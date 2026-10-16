const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { loadRoutes } = require('../nginx-conf');
const { loadEcosystem } = require('./registry');
const gitignore = require('./gitignore');

/**
 * 서비스 추가 마법사 1단계 — 새 서비스의 최소 동작 스켈레톤을 디스크에 만든다.
 *
 * manager 가 settings.ini 밖의 파일을 쓰는 것은 이번이 처음이다. 그래서 쓰기
 * 범위를 최대한 좁힌다:
 *
 *   - 항상 `services/<새이름>/` 신규 디렉터리 하나만 만든다. 이미 있으면 멈춘다.
 *   - 내용은 이 파일과 같이 커밋된 고정 템플릿(templates/service-skeleton/)
 *     에서만 온다. 사용자가 보낸 값은 `{{NAME}}`/`{{PORT}}` 자리표시자를
 *     채우는 데만 쓰이고, 파일 경로를 만드는 데는 쓰이지 않는다.
 *   - 임시 디렉터리에 전부 렌더링한 뒤 한 번에 rename 한다 — 중간에 실패하면
 *     실제 서비스 경로에는 아무것도 남지 않는다.
 */

const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NAME_MAX_LEN = 40;

// 내부 HTTP 포트 대역. docs/ports.md '내부 HTTP 포트 — 28080번대' 의 28080번대
// 한 블록을 그대로 따른다 — Janus WebRTC(20000-20200) 등 미디어 포트 대역과
// 겹치지 않는, 이미 검증된 자리다.
const PORT_MIN = 28080;
const PORT_MAX = 28099;

// 서비스 추가로 만드는 것은 **plug-in 뿐이다.** 패키지에 포함되는(in-repo) 서비스는 이 저장소가 직접 들고
// 가는 것이라 마법사가 만들지 않는다 — 예전에는 고를 수 있었고 .gitignore 예외까지 더했다.
const TRACKS = new Set(['plugin']);
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'service-skeleton');
const TEMPLATE_EXT = '.tmpl';

class ScaffoldError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 지금 선언돼 있는 이름·포트. 빠른 사전 점검용 — 최종 판정은 2단계의 nginx/pm2 --check. */
function existingState() {
  const { routes } = loadRoutes(config.nginxStackPath);
  const apps = loadEcosystem(config.ecosystemPath);

  const names = new Set();
  const ports = new Set();

  for (const route of routes) {
    names.add(route.name);
    for (const p of route.ports || []) ports.add(p);
  }
  for (const app of apps) {
    names.add(app.name);
    if (app.port) ports.add(app.port);
  }

  return { names: [...names], ports: [...ports] };
}

function suggestPort(usedPorts) {
  const used = new Set(usedPorts);
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

/** 마법사 1단계 폼이 미리 보여줄 것 — 이름/포트 실시간 검증에 쓴다. */
function defaults() {
  const { names, ports } = existingState();
  return {
    existingNames: names,
    usedPorts: ports,
    portRange: { min: PORT_MIN, max: PORT_MAX },
    suggestedPort: suggestPort(ports),
    slugPattern: SLUG_RE.source,
    nameMaxLength: NAME_MAX_LEN,
  };
}

function assertValidName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX_LEN || !SLUG_RE.test(name)) {
    throw new ScaffoldError(
      'invalid_name',
      `이름은 소문자로 시작하는 소문자·숫자·하이픈 조합이어야 합니다(최대 ${NAME_MAX_LEN}자, 예: stock-analyzer).`
    );
  }
}

function assertValidPort(port) {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new ScaffoldError('invalid_port', `포트는 ${PORT_MIN}-${PORT_MAX} 사이의 정수여야 합니다.`);
  }
}

function assertValidTrack(track) {
  if (!TRACKS.has(track)) {
    throw new ScaffoldError('invalid_track', '서비스 추가로는 plug-in 만 만들 수 있습니다 (자기 저장소를 가지는 서비스).');
  }
}

function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!(key in vars)) throw new Error(`template placeholder not provided: ${key}`);
    return vars[key];
  });
}

/** TEMPLATE_DIR 아래 모든 *.tmpl 파일을, TEMPLATE_DIR 기준 상대 경로로 모은다. */
function listTemplateFiles(dir, base) {
  const acc = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      acc.push(...listTemplateFiles(full, base));
    } else if (entry.name.endsWith(TEMPLATE_EXT)) {
      acc.push(path.relative(base, full));
    }
  }
  return acc;
}

/**
 * create({ name, port, track }) → { name, port, track, dir, files, gitignore }
 * 실패하면 ScaffoldError 를 던지고, services/ 아래에는 아무것도 남기지 않는다.
 */
function create({ name, port, track = 'plugin' }) {
  assertValidName(name);
  assertValidPort(port);
  assertValidTrack(track);

  const { names, ports } = existingState();
  if (names.includes(name)) {
    throw new ScaffoldError('already_exists', `이미 선언돼 있는 이름입니다: ${name}`);
  }
  if (ports.includes(port)) {
    throw new ScaffoldError('port_in_use', `이미 쓰이고 있는 포트입니다: ${port}`);
  }

  const servicesRoot = path.resolve(config.repoRoot, 'services');
  const finalDir = path.resolve(servicesRoot, name);

  // SLUG_RE 가 경로 구분자·상위 디렉터리 이동을 이미 막지만, 한 번 더 본다 —
  // 이 함수가 실제로 디렉터리를 만드는 자리이기 때문이다.
  if (path.dirname(finalDir) !== servicesRoot) {
    throw new ScaffoldError('invalid_name', '이름에 경로 구분자를 쓸 수 없습니다.');
  }
  if (fs.existsSync(finalDir)) {
    throw new ScaffoldError('already_exists', `이미 있는 디렉터리입니다: services/${name}`);
  }

  const stagingDir = path.resolve(servicesRoot, `.wizard-tmp-${name}-${crypto.randomBytes(4).toString('hex')}`);
  const vars = { NAME: name, PORT: String(port) };

  try {
    const templateFiles = listTemplateFiles(TEMPLATE_DIR, TEMPLATE_DIR);
    for (const rel of templateFiles) {
      const destPath = path.join(stagingDir, rel.slice(0, -TEMPLATE_EXT.length));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const rendered = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'utf8'), vars);
      fs.writeFileSync(destPath, rendered);
    }
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  // 준비가 끝난 뒤에만 실제 자리로 옮긴다 — 여기부터는 rename 하나뿐이라
  // 부분 생성이 있을 수 없다(같은 파일시스템 안의 rename은 원자적이다).
  fs.renameSync(stagingDir, finalDir);

  // plug-in 은 .gitignore 를 건드리지 않는다 — 이 디렉터리는 계속 무시되고, 서비스가 자기 저장소를 가진다.
  const gitignoreResult = null;

  const files = listTemplateFiles(TEMPLATE_DIR, TEMPLATE_DIR)
    .map((rel) => path.posix.join('services', name, rel.slice(0, -TEMPLATE_EXT.length).split(path.sep).join('/')));

  return { name, port, track, dir: `services/${name}`, files, gitignore: gitignoreResult };
}

module.exports = { defaults, create, existingState, assertValidName, ScaffoldError, SLUG_RE, PORT_MIN, PORT_MAX };
