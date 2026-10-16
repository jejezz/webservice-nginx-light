const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const { loadRoutes } = require('../nginx-conf');
const decl = require('./declarations');
const { loadEcosystem } = require('./registry');
const checkRunner = require('./check-runner');
const scaffold = require('./scaffold');
const { PROTECTED } = require('./remove');

const execFileAsync = promisify(execFile);

/**
 * "이미 받아 둔 폴더" 를 서비스로 등록하기 전의 **읽기 전용 진단**.
 *
 * 사용자가 `services/` 안에 직접 clone 해 둔 폴더가 서비스로 붙을 수 있는지를 본다. 서비스 추가 마법사의
 * 새 틀 만들기는 이미 있는 폴더를 거절하므로(scaffold.js), 이 폴더들은 지금까지 화면에서 들어갈 입구가 없었다.
 *
 * 경계 — 이 모듈은 **읽기만 한다**:
 *   - 그 폴더의 코드를 실행하지 않는다. npm 도 부르지 않는다. 보는 것은 파일 이름과 package.json · ini 의
 *     값뿐이다 (그 repo 가 믿을 수 있는 것인지 알 수 없다).
 *   - 파일을 쓰지 않는다. 폴더 이름은 슬러그만 받고 services/ 바로 아래 한 단계로만 만든다.
 *   - 소켓은 127.0.0.1 의 선언된 포트에 짧게 연결해 보는 것 하나뿐이다.
 *
 * 결과는 점검 규약의 레벨(ok · skip · pending · problem)로 낸다 — 구축 마법사의 점검과 같은 화면 부품을 쓴다.
 */

const PORT_MIN = scaffold.PORT_MIN;
const PORT_MAX = scaffold.PORT_MAX;

function servicesRoot() {
  return path.resolve(config.repoRoot, 'services');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 127.0.0.1:port 에 연결되는가 (0.5초). */
function portListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function trackedFileCount(name) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--', `services/${name}`], { cwd: config.repoRoot, timeout: 5000 });
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

/** 등록 후보 — services/ 바로 아래 폴더 중 패키지에 든 것이 아닌 것. */
function candidates() {
  const root = servicesRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !PROTECTED.has(e.name))
    .map((e) => {
      const dir = path.join(root, e.name);
      return {
        name: e.name,
        validName: scaffold.SLUG_RE.test(e.name),
        declared: decl.listIni(path.join(dir, 'nginx-conf')).length + decl.listIni(path.join(dir, 'pm2-conf')).length > 0,
        hasGit: fs.existsSync(path.join(dir, '.git')),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** package.json 이 있는 폴더(서비스 루트 또는 pm2 cwd)를 찾아 런타임을 감지한다. */
function detectRuntime(dir, cwdDir) {
  const spots = [...new Set([cwdDir, dir])];
  for (const d of spots) {
    const pkg = readJson(path.join(d, 'package.json'));
    if (pkg) return { runtime: 'node', dir: d, pkg };
  }
  for (const d of spots) {
    if (fs.existsSync(path.join(d, 'requirements.txt')) || fs.existsSync(path.join(d, 'pyproject.toml'))) return { runtime: 'python', dir: d };
    if (fs.existsSync(path.join(d, 'go.mod'))) return { runtime: 'go', dir: d };
    if (fs.existsSync(path.join(d, 'pom.xml')) || fs.existsSync(path.join(d, 'build.gradle'))) return { runtime: 'java', dir: d };
    if (fs.existsSync(path.join(d, 'Cargo.toml'))) return { runtime: 'rust', dir: d };
  }
  return { runtime: null, dir };
}

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** 한 cwd 의 런타임·의존성·빌드·설치 스크립트를 본다. app 은 그 cwd 를 쓰는 pm2 선언(없을 수 있다). */
function inspectRuntime({ dir, cwdDir, app, add, detected }) {
  const rt = detectRuntime(dir, cwdDir);
  const where = path.relative(dir, rt.dir) || '.';
  if (!detected.runtime) detected.runtime = rt.runtime;
  if (!rt.runtime) {
    add('skip', `${where}: 런타임을 감지하지 못했습니다 (package.json · requirements.txt · go.mod 등이 없습니다)`);
    return;
  }
  if (rt.runtime !== 'node') {
    const interp = app && app.interpreter;
    add('pending', `${where}: ${rt.runtime} 프로젝트로 보입니다 — pm2 가 node 로 띄우므로 ${interp ? `interpreter(${interp})를` : 'pm2-conf 의 interpreter 를'} 직접 맞춰야 합니다`);
    return;
  }

  const pkg = rt.pkg;
  const entryHint = pkg.main || (pkg.scripts && pkg.scripts.start) || null;
  if (!detected.entry) detected.entry = entryHint;
  add('ok', `${where}: Node 프로젝트입니다${entryHint ? ` — 진입 후보: ${entryHint}` : ''}`);

  const hasLock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((f) => fs.existsSync(path.join(rt.dir, f)));
  if (fs.existsSync(path.join(rt.dir, 'node_modules'))) add('ok', `${where}: node_modules 가 있습니다 (의존성 설치됨)`);
  else add('pending', `${where}: node_modules 가 없습니다 — 의존성을 설치해야 합니다 (cd ${path.relative(config.repoRoot, rt.dir)} && ${hasLock ? 'npm ci' : 'npm install'})`);
  if (!hasLock) add('skip', `${where}: lockfile 이 없습니다 — 설치할 때마다 버전이 달라질 수 있습니다`);
  if (pkg.scripts && pkg.scripts.build) add('skip', `${where}: build 스크립트가 있습니다 (npm run build) — 진입 파일이 빌드 산출물이면 먼저 빌드해야 합니다`);

  const want = pkg.engines && pkg.engines.node;
  if (want) {
    const major = Number(process.versions.node.split('.')[0]);
    const m = String(want).match(/(\d+)/);
    if (m && major < Number(m[1]) && /^[>^~]?=?\s*\d/.test(String(want))) add('pending', `${where}: engines.node = ${want} 인데 이 장비의 Node 는 ${process.versions.node} 입니다`);
    else add('ok', `${where}: engines.node = ${want} (이 장비 ${process.versions.node})`);
  }

  // 설치할 때 실행되는 스크립트 — 남의 코드가 설치 중에 돈다는 신호
  const hooks = INSTALL_HOOKS.filter((h) => pkg.scripts && pkg.scripts[h]);
  if (hooks.length) {
    add('pending', `${where}: 설치할 때 실행되는 스크립트가 있습니다: ${hooks.map((h) => `${h} = ${String(pkg.scripts[h]).slice(0, 60)}`).join(' · ')} — 내용을 확인한 뒤 설치하세요 (npm ci --ignore-scripts 로 건너뛸 수 있습니다)`);
  }
}

// ── 플러그인 자체 진단 ───────────────────────────────────────────
//
// plug-in 은 자기 저장소를 가지므로 "뜰 준비가 됐는가" 를 스스로 가장 잘 안다. package.json 의 scripts.doctor 가
// 점검 규약 JSON({ step, state, checks[] })을 내면 이 화면이 그것을 보여 준다.
//
// 이것은 **그 폴더의 코드를 실행**하는 유일한 자리다. 그래서 좁게 잡았다:
//   - 사람이 버튼을 눌렀을 때만, 관리자만 (routes/wizard.js).
//   - doctor 스크립트가 `node <상대경로>.js` 꼴일 때만. npm 을 거치지 않으므로 pre/post 수명주기 스크립트가
//     돌지 않고, 셸을 거치지 않는다 (execFile).
//   - 그 파일은 cwd 안에 있어야 하고, 환경 변수는 PATH · HOME 등으로 추린다 (check-runner 와 같다).
//   - 타임아웃 30초, 출력 상한 1MB, 같은 폴더는 겹쳐 돌리지 않는다.
const DOCTOR_RE = /^node\s+((?:\.\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:js|cjs|mjs))$/;
const DOCTOR_TIMEOUT_MS = 30000;
const doctorInFlight = new Set();

/** package.json 의 doctor 스크립트를 실행 가능한 (상대 경로) 꼴로 읽는다. 아니면 이유를 돌려준다. */
function parseDoctor(pkg, cwdAbs) {
  const script = pkg && pkg.scripts && pkg.scripts.doctor;
  if (!script) return null;
  const scripts = pkg.scripts;
  if (scripts.predoctor || scripts.postdoctor) {
    return { script, runnable: false, reason: 'predoctor · postdoctor 스크립트가 있어 npm 수명주기가 돕니다 — 이 화면은 doctor 만 직접 실행합니다' };
  }
  const m = String(script).trim().match(DOCTOR_RE);
  if (!m) {
    return { script, runnable: false, reason: '"node <상대경로>.js" 꼴만 실행합니다 (셸 명령 · 인자 · 상위 경로는 안 됩니다)' };
  }
  const file = path.resolve(cwdAbs, m[1]);
  if (!(file === cwdAbs || file.startsWith(`${cwdAbs}${path.sep}`)) || !fs.existsSync(file)) {
    return { script, runnable: false, reason: `스크립트 파일이 없거나 폴더 밖입니다: ${m[1]}` };
  }
  return { script, runnable: true, file: path.relative(cwdAbs, file) };
}

function collectSelfDiagnosis({ dir, cwdDir, detected }) {
  const pkg = readJson(path.join(cwdDir, 'package.json'));
  if (!pkg) return;
  const cwd = path.relative(dir, cwdDir);
  if (detected.selfDiagnosis.some((d) => d.cwd === cwd)) return;
  const info = parseDoctor(pkg, cwdDir);
  if (info) detected.selfDiagnosis.push({ cwd, script: info.script, runnable: info.runnable, reason: info.reason || null });
}

/**
 * 자체 진단을 실행한다. cwd 는 보고서가 알려 준 후보(선언된 pm2 cwd)만 받는다 — 요청이 경로를 만들지 않는다.
 * 반환: { cwd, ranAt, durationMs, exitCode, state, checks } 또는 { error }.
 */
async function runSelfDiagnosis(name, cwdRel) {
  scaffold.assertValidName(name);
  if (PROTECTED.has(name)) throw new InspectError('protected', `${name} 은(는) 패키지에 포함된 서비스입니다.`);

  const dir = path.join(servicesRoot(), name);
  if (!isDir(dir)) throw new InspectError('not_found', `services/${name} 폴더가 없습니다.`);

  // 후보는 선언된 pm2 cwd 뿐이다.
  const { pm2 } = decl.pair(dir);
  const allowed = [...new Set(pm2.map((a) => path.resolve(dir, a.cwd)))].filter((c) => c === dir || c.startsWith(`${dir}${path.sep}`));
  const cwdAbs = path.resolve(dir, cwdRel || '.');
  if (!allowed.includes(cwdAbs)) throw new InspectError('invalid_cwd', '이 폴더의 pm2 선언이 가리키는 cwd 가 아닙니다.');

  const pkg = readJson(path.join(cwdAbs, 'package.json'));
  const info = parseDoctor(pkg, cwdAbs);
  if (!info) throw new InspectError('no_doctor', 'package.json 에 doctor 스크립트가 없습니다.');
  if (!info.runnable) throw new InspectError('not_runnable', info.reason);

  const key = `${name}:${cwdAbs}`;
  if (doctorInFlight.has(key)) throw new InspectError('busy', '이미 진단이 돌고 있습니다.');
  doctorInFlight.add(key);
  const startedAt = Date.now();
  try {
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [info.file, '--json'],
        { cwd: cwdAbs, env: checkRunner.childEnv(), timeout: DOCTOR_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: (stderr || '').trim() }),
      );
    });
    const exitCode = result.err ? (typeof result.err.code === 'number' ? result.err.code : null) : 0;
    const base = { cwd: path.relative(dir, cwdAbs), ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, exitCode };
    if (result.err && result.err.killed) return { ...base, error: `${DOCTOR_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단했습니다.` };
    if (result.err && typeof result.err.code === 'string') return { ...base, error: `실행하지 못했습니다 (${result.err.code}).` };
    const report = checkRunner.parseReport(result.stdout);
    if (!report) {
      return { ...base, error: '진단 출력이 점검 규약 JSON({ step, state, checks[] })이 아닙니다.', stderr: result.stderr.slice(0, 2000) || null };
    }
    return { ...base, state: checkRunner.deriveState(report.checks), checks: report.checks };
  } finally {
    doctorInFlight.delete(key);
  }
}

class InspectError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function inspect(name) {
  scaffold.assertValidName(name);

  const checks = [];
  const add = (level, text) => checks.push({ level, text });
  const detected = { runtime: null, port: null, entry: null, declared: false, services: [], selfDiagnosis: [] };

  if (PROTECTED.has(name)) {
    add('problem', `${name} 은(는) 패키지에 포함된 서비스입니다 — 등록 대상이 아닙니다.`);
    return { name, dir: `services/${name}`, state: 'problem', checks, detected, ready: false };
  }

  const dir = path.join(servicesRoot(), name);
  const rel = `services/${name}`;

  // ── 1. 폴더 ──────────────────────────────────────────────
  if (!isDir(dir)) {
    add('problem', `${rel} 폴더가 없습니다 (심볼릭 링크는 받지 않습니다).`);
    return { name, dir: rel, state: 'problem', checks, detected, ready: false };
  }
  add('ok', `${rel} 폴더가 있습니다`);

  const tracked = await trackedFileCount(name);
  if (tracked) add('problem', `이 저장소의 git 이 추적하는 파일이 ${tracked}개 있습니다 — plug-in 은 자기 저장소를 가져야 합니다.`);
  if (fs.existsSync(path.join(dir, '.git'))) add('ok', '자기 저장소(.git)를 가집니다 — plug-in');
  else add('skip', `git 저장소가 아닙니다 — plug-in 은 자기 저장소를 가집니다 (cd ${rel} && git init)`);

  // ── 2. 선언 ──────────────────────────────────────────────
  // 한 폴더가 서비스를 둘 이상 담을 수 있다 (declarations.js). 선언 파일을 전부 읽고 이름으로 짝을 맺는다.
  const { nginx, pm2, services } = decl.pair(dir);
  detected.declared = nginx.length > 0 && pm2.length > 0;
  detected.services = services.map((e) => ({
    name: e.name,
    ports: decl.portsOf(e),
    location: e.nginx && e.nginx.routes[0] ? e.nginx.routes[0].location : null,
  }));

  if (nginx.length === 0) {
    add('pending', 'nginx-conf/*.ini 선언이 없습니다 — 라우트(location)와 포트를 이 폴더에 선언해야 nginx 가 길을 만듭니다');
  }
  for (const n of nginx) {
    add('ok', `${n.file} — name = ${n.name || '(없음)'}, ports = ${n.ports.join(' ') || '(없음)'}, 라우트 ${n.routes.length}개`);
    if (n.name && n.routes.length === 0) add('pending', `${n.file} 에 [route:…] 가 없습니다 — 공개할 경로가 하나도 없습니다`);
  }
  if (pm2.length === 0) {
    add('pending', 'pm2-conf/*.ini 선언이 없습니다 — pm2 가 무엇을 어떻게 띄울지(script · cwd · PORT)를 이 폴더에 선언해야 합니다');
  }
  for (const a of pm2) {
    add('ok', `${a.file} — name = ${a.name || '(없음)'}, script = ${a.script || '(없음)'}, cwd = ${a.cwd}${a.port ? `, PORT = ${a.port}` : ''}`);
  }

  // 서비스마다: nginx 의 [service] name 과 pm2 의 [app] name 이 같아야 한 서비스다. 폴더 이름과 같을 필요는 없다.
  for (const e of services) {
    const label = e.name || '(이름 없음)';
    if (e.nginx && e.app) {
      add('ok', `서비스 ${label} — nginx 선언과 pm2 선언이 짝입니다`);
      if (e.nginx.ports.length && e.app.port && !e.nginx.ports.includes(e.app.port)) {
        add('problem', `서비스 ${label} — nginx 의 ports(${e.nginx.ports.join(' ')})와 pm2 의 PORT(${e.app.port})가 다릅니다 — 같아야 합니다`);
      }
    } else if (e.nginx && !e.app) {
      add('problem', `서비스 ${label} — nginx 선언만 있고 같은 이름의 pm2 선언이 없습니다 (이름이 다른 것일 수 있습니다)`);
    } else if (!e.nginx && e.app) {
      add('skip', `서비스 ${label} — pm2 선언만 있습니다 (nginx 라우트 없이 포트로 직접 쓰는 서비스)`);
    }
  }
  const unnamed = services.filter((e) => !e.name);
  if (unnamed.length) add('problem', '이름(name)이 없는 선언이 있습니다 — [service] name · [app] name 이 필요합니다');
  const names = services.map((e) => e.name).filter(Boolean);
  if (names.length && !names.includes(name)) {
    add('skip', `서비스 이름(${names.join(', ')})이 폴더 이름(${name})과 다릅니다 — 한 폴더에 서비스 여럿을 담거나 repo 이름이 다른 경우로, 문제가 아닙니다`);
  }

  // ── 3. 이름·포트가 다른 서비스와 겹치는가 (이 폴더 자신의 선언은 뺀다) ──
  const ownNames = new Set(names);
  const ownPorts = [...new Set(services.flatMap((e) => decl.portsOf(e)))];
  detected.port = ownPorts[0] || null;
  for (const p of ownPorts) {
    if (p < PORT_MIN || p > PORT_MAX) add('pending', `포트 ${p} 는 내부 HTTP 포트 대역(${PORT_MIN}-${PORT_MAX}) 밖입니다`);
  }
  if (ownPorts.length || names.length) {
    try {
      const { routes } = loadRoutes(config.nginxStackPath);
      const apps = loadEcosystem(config.ecosystemPath);
      const otherPorts = new Map();
      const otherNames = new Set();
      for (const r of routes) {
        if (r.group === name || ownNames.has(r.name)) continue;
        otherNames.add(r.name);
        for (const p of r.ports || []) otherPorts.set(Number(p), r.name);
      }
      for (const a of apps) {
        if (a.dir === name || ownNames.has(a.name)) continue;
        otherNames.add(a.name);
        if (a.port) otherPorts.set(a.port, a.name);
      }
      const nameClash = names.filter((n) => otherNames.has(n));
      if (nameClash.length) add('problem', `이름이 이미 다른 폴더의 서비스에 쓰이고 있습니다: ${nameClash.join(', ')}`);
      const clash = ownPorts.filter((p) => otherPorts.has(p));
      if (clash.length) add('problem', `포트가 이미 다른 서비스에 선언돼 있습니다: ${clash.map((p) => `${p}(${otherPorts.get(p)})`).join(', ')}`);
      else if (ownPorts.length) add('ok', `포트 ${ownPorts.join(' ')} 는 다른 선언과 겹치지 않습니다`);
    } catch {
      add('skip', '다른 서비스의 선언을 읽지 못해 이름·포트 충돌은 건너뜁니다');
    }
  } else if (nginx.length || pm2.length) {
    add('pending', '포트가 선언돼 있지 않습니다 (nginx 의 ports · pm2 의 [env] PORT)');
  }

  // ── 4. 진입 파일 · 런타임 (pm2 앱마다, cwd 별로 한 번) ────
  const insideDir = (p) => p === dir || p.startsWith(`${dir}${path.sep}`);
  const seenCwd = new Set();
  const envDirs = new Set();
  for (const a of pm2) {
    const cwdDir = path.resolve(dir, a.cwd);
    if (!insideDir(cwdDir)) {
      add('problem', `${a.name || a.file} 의 pm2 cwd(${a.cwd})가 이 폴더 밖을 가리킵니다`);
      continue;
    }
    envDirs.add(cwdDir);
    if (a.script) {
      const entry = path.resolve(cwdDir, a.script);
      if (!insideDir(entry)) add('problem', `${a.name || a.file} 의 pm2 script(${a.script})가 이 폴더 밖을 가리킵니다`);
      else if (fs.existsSync(entry)) add('ok', `${a.name || a.file} 의 진입 파일이 있습니다: ${path.relative(dir, entry)}`);
      else add('pending', `${a.name || a.file} 의 진입 파일이 아직 없습니다: ${path.relative(dir, entry)} — 빌드나 설치 전일 수 있습니다`);
    }
    if (seenCwd.has(cwdDir)) continue;
    seenCwd.add(cwdDir);
    inspectRuntime({ dir, cwdDir, app: a, add, detected });
    collectSelfDiagnosis({ dir, cwdDir, detected });
  }
  if (detected.selfDiagnosis.length === 0 && pm2.length > 0) {
    add('skip', '이 repo 에는 자체 진단(package.json 의 "doctor" 스크립트)이 없습니다 — 두면 이 화면에서 실행해 볼 수 있습니다 (docs/guide/rollout.md)');
  } else if (detected.selfDiagnosis.length > 0) {
    add('ok', `자체 진단이 있습니다: ${detected.selfDiagnosis.map((d) => `${d.cwd || '.'} (${d.script})`).join(', ')} — 아래에서 실행할 수 있습니다`);
  }
  if (pm2.length === 0) {
    // 선언이 없어도 런타임은 알려 준다 — 선언을 만들 때 쓸 감지 결과다.
    inspectRuntime({ dir, cwdDir: dir, app: null, add, detected });
    envDirs.add(dir);
  }

  // ── 5. 환경 · DB ─────────────────────────────────────────
  for (const d of envDirs) {
    const hasExample = ['.env.example', '.env.sample'].some((f) => fs.existsSync(path.join(d, f)));
    if (hasExample && !fs.existsSync(path.join(d, '.env'))) {
      add('pending', `${path.relative(dir, d) || '.'}/.env 가 없습니다 — .env.example 을 복사해 값을 채워야 합니다`);
    }
  }
  const dbFiles = decl.listIni(path.join(dir, 'db-conf'));
  if (dbFiles.length) add('ok', `db-conf 선언이 있습니다 (${dbFiles.length}개) — database/setup_mariadb.sh 가 DB 와 계정을 만듭니다`);
  else if (['schema', 'migrations', 'db'].some((d) => isDir(path.join(dir, d)))) {
    add('skip', 'schema/ · migrations/ 가 있는데 db-conf 선언이 없습니다 — DB 가 필요하면 db-conf/database.ini 를 두세요');
  }

  // ── 6. 지금 그 포트를 쓰고 있는가 ────────────────────────
  for (const p of ownPorts) {
    if (await portListening(p)) add('skip', `127.0.0.1:${p} 가 이미 열려 있습니다 — 이 서비스가 이미 떠 있거나 다른 프로세스가 쓰는 중입니다`);
    else add('ok', `127.0.0.1:${p} 는 비어 있습니다`);
  }

  const state = checkRunner.deriveState(checks);
  const hasBlockers = checks.some((c) => c.level === 'problem');
  return {
    name,
    dir: rel,
    state,
    checks,
    detected,
    // 선언이 둘 다 있고 막는 것이 없으면 2단계(등록 점검)로 넘어갈 수 있다.
    ready: detected.declared && !hasBlockers,
  };
}

module.exports = { inspect, candidates, runSelfDiagnosis, InspectError };
