const fs = require('fs');
const path = require('path');
const config = require('../config');
const checkRunner = require('./check-runner');
const gitignore = require('./gitignore');
const health = require('./health');
const { parseIni } = require('../nginx-conf');
const decl = require('./declarations');

/**
 * 서비스 추가 마법사 2단계 — 등록 + 무결성 확인.
 *
 * docs/guide/rollout.md '등록 순서' 의 수동 절차를 그대로 보여주되, manager 는
 * **아무것도 대신 실행하지 않는다.** 여기서 하는 것은 두 가지뿐이다:
 *
 *   1. commands() — 복사해서 터미널에 붙여 넣을 명령 문자열을 만든다(실행 없음).
 *   2. checklist()/runCheck() — 이미 반영된 상태를 읽기만 한다. 스크립트를
 *      돌리는 두 항목(nginx.check·pm2.check)은 setup.js 와 같은 execFile
 *      샌드박스(check-runner.js)를 거치고, --check 모드만 쓴다.
 */

function serviceDir(name) {
  return path.resolve(config.repoRoot, 'services', name);
}

function exists(name) {
  return fs.existsSync(serviceDir(name));
}

function readIniValue(file, section, key) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { sections } = parseIni(text);
  return sections[section]?.[key] ?? null;
}

/**
 * 선언이 서비스마다 짝이 맞는가 — nginx 의 [service] name 과 pm2 의 [app] name 이 같아야 한다.
 *
 * 예전에는 service.ini · app.ini 한 쌍의 name 이 **폴더 이름**과 같은지 보았는데, 그것은 서비스 추가 마법사가
 * 만든 스켈레톤에만 맞는다. 직접 clone 한 repo 는 서비스를 여럿 담거나(apartment-mgmt-server-node 는
 * huygens-server 와 web-cassini) repo 이름이 다를 수 있다. 그래서 선언 파일 전부를 읽어 **이름으로 짝**을 본다.
 */
function checkNamesMatch(name) {
  const { nginx, pm2, services } = decl.pair(serviceDir(name));

  const checks = [];
  if (nginx.length === 0) checks.push({ level: 'problem', text: 'nginx-conf/*.ini 선언이 없습니다.' });
  if (pm2.length === 0) checks.push({ level: 'problem', text: 'pm2-conf/*.ini 선언이 없습니다.' });

  for (const e of services) {
    const label = e.name || '(이름 없음)';
    if (!e.name) {
      checks.push({ level: 'problem', text: `${(e.nginx || e.app).file} 에 name 이 없습니다 ([service] name · [app] name).` });
    } else if (e.nginx && e.app) {
      checks.push({ level: 'ok', text: `${label} — nginx 선언(${e.nginx.file})과 pm2 선언(${e.app.file})의 name 이 같습니다` });
    } else if (e.nginx && !e.app) {
      checks.push({ level: 'problem', text: `${label} — nginx 선언(${e.nginx.file})만 있고 같은 name 의 pm2 선언이 없습니다.` });
    } else {
      checks.push({ level: 'ok', text: `${label} — pm2 선언만 있습니다 (nginx 라우트 없이 포트로 직접 쓰는 서비스)` });
    }
  }

  return { checks, state: checkRunner.deriveState(checks) };
}

/** /health 한 곳을 본다. serviceName 은 응답의 service 필드가 같아야 하는 이름이다. */
async function checkHealthOne(serviceName, port, prefix) {
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const result = await health.checkOne({ healthUrl, insecureTls: false, proxyPass: null });

  if (result.status === 'down' || result.status === 'unknown') {
    return [{ level: 'pending', text: `${prefix}아직 응답이 없습니다 (${healthUrl}) — pm2 로 띄운 뒤 다시 확인하세요.` }];
  }

  const body = result.body;
  const checks = [];
  if (!body || typeof body !== 'object') {
    checks.push({ level: 'problem', text: `${prefix}/health 응답이 JSON 객체가 아닙니다.` });
  } else {
    if (body.service === serviceName) {
      checks.push({ level: 'ok', text: `${prefix}service 필드가 이름과 같습니다 (${body.service})` });
    } else {
      checks.push({ level: 'problem', text: `${prefix}/health 의 service(${body.service})가 이름(${serviceName})과 다릅니다.` });
    }
    if (typeof body.timestamp === 'string' && body.timestamp) {
      checks.push({ level: 'ok', text: `${prefix}timestamp 필드가 있습니다` });
    } else {
      checks.push({ level: 'problem', text: `${prefix}timestamp 필드가 없습니다 (docs/guide/contracts.md "/health 응답 규약").` });
    }
    if (result.status === 'degraded') {
      checks.push({ level: 'pending', text: `${prefix}status 가 정상 값이 아닙니다: ${body.status}` });
    }
  }
  return checks;
}

/**
 * 실제로 떠 있으면 /health 를 호출해 규약(service·status·timestamp)을 본다.
 * 선언된 서비스마다(이름 · 포트) 본다 — 한 폴더에 서비스가 여럿일 수 있다. 선언에서 포트를 못 찾으면
 * 호출자가 준 port 와 폴더 이름으로 본다(스켈레톤을 막 만든 경우).
 */
async function checkHealthContract(name, port) {
  const { services } = decl.pair(serviceDir(name));
  const targets = services
    .map((e) => ({ name: e.name, port: decl.portsOf(e)[0] }))
    .filter((t) => t.name && t.port);
  if (targets.length === 0 && port) targets.push({ name, port });

  const checks = [];
  for (const t of targets) {
    checks.push(...(await checkHealthOne(t.name, t.port, targets.length > 1 ? `${t.name}: ` : '')));
  }
  if (checks.length === 0) checks.push({ level: 'pending', text: '선언에서 포트를 찾지 못했습니다 — nginx 의 ports · pm2 의 PORT 를 선언하세요.' });
  return { checks, state: checkRunner.deriveState(checks) };
}

function checkGitignoreEntry(name) {
  const has = gitignore.hasEntry(name);
  return {
    state: has ? 'complete' : 'incomplete',
    checks: [
      has
        ? { level: 'ok', text: `.gitignore 에 !services/${name}/ 예외가 있습니다.` }
        : { level: 'pending', text: `.gitignore 에 !services/${name}/ 가 아직 없습니다.` },
    ],
  };
}

const GLOBAL_CHECK_SPECS = {
  'nginx.check': { cwd: 'nginx', file: './generate_nginx_conf.py', args: ['--check', '--json'] },
  'pm2.check': { cwd: 'pm2', file: './ecosystem.config.js', args: ['--check-json'], interpreter: 'node' },
};

/** 서비스 하나의 등록 체크리스트. 아직 안 만든 서비스면 null. */
function checklist(name, { port, track = 'plugin' } = {}) {
  if (!exists(name)) return null;

  const items = [
    { id: 'names.match', title: '이름이 세 곳에서 같은가', kind: 'inline' },
    { id: 'health.contract', title: '/health 가 규약대로 응답하는가', kind: 'inline' },
    { id: 'nginx.check', title: 'nginx 선언에 충돌이 없는가 (전체)', kind: 'script' },
    { id: 'pm2.check', title: 'pm2 선언에 충돌이 없는가 (전체)', kind: 'script' },
  ];
  if (track === 'in-repo') {
    items.push({ id: 'gitignore.entry', title: '.gitignore 예외가 있는가', kind: 'inline' });
  }
  return items;
}

/** 한 항목을 점검한다. 반환 모양은 setup.js 의 check() 결과와 같다. */
async function runCheck(name, checkId, { port } = {}) {
  if (!exists(name)) {
    return { stepId: checkId, ranAt: new Date().toISOString(), state: 'unknown', checks: [], error: 'unknown_service' };
  }

  const base = { stepId: checkId, ranAt: new Date().toISOString() };

  if (checkId === 'names.match') {
    return { ...base, ...checkNamesMatch(name), error: null };
  }
  if (checkId === 'health.contract') {
    // 포트는 선언에서 읽는다 (서비스마다). 선언이 없을 때만 호출자가 준 값을 쓴다.
    return { ...base, ...(await checkHealthContract(name, port)), error: null };
  }
  if (checkId === 'gitignore.entry') {
    return { ...base, ...checkGitignoreEntry(name), error: null };
  }

  const spec = GLOBAL_CHECK_SPECS[checkId];
  if (!spec) return { ...base, state: 'unknown', checks: [], error: 'unknown_check' };

  // 이 둘은 이 저장소 전체의 선언을 보는 전역 점검이다 — 새 서비스 하나만
  // 보는 것이 아니라서 setup.js 처럼 "이 스크립트는 다른 단계를 보고했다" 를
  // 판정하지 않는다(report.step 을 우리 checkId 와 비교하지 않는다).
  const run = await checkRunner.runScript(spec);
  if (run.timedOut) return { ...base, state: 'unknown', checks: [], error: '점검이 시간 안에 끝나지 않았습니다.' };
  if (run.spawnError) return { ...base, state: 'unknown', checks: [], error: `점검 스크립트를 실행할 수 없습니다 (${run.spawnError}).` };

  const report = checkRunner.parseReport(run.stdout);
  if (!report) return { ...base, state: 'unknown', checks: [], error: '점검 출력을 읽지 못했습니다.', stderr: run.stderr || null };

  return { ...base, state: checkRunner.deriveState(report.checks), checks: report.checks, error: null };
}

/**
 * docs/guide/rollout.md '등록 순서' 2~6단계를 복사용 명령으로 텍스트 치환만 한다 — 실행하지 않는다.
 * 선언에서 서비스(이름 · 포트 · 경로)를 읽어 채우므로 한 폴더에 서비스가 여럿이어도 맞다.
 */
function commands(name, { port, track = 'plugin' } = {}) {
  const dir = serviceDir(name);
  const { pm2, services } = decl.pair(dir);

  const appNames = pm2.filter((a) => a.name && a.enabled).map((a) => a.name);
  const ports = [...new Set(services.map((e) => decl.portsOf(e)[0]).filter(Boolean))];
  if (ports.length === 0 && port) ports.push(port);
  // 일반 경로(접두사)로 열린 라우트만 curl 로 확인할 수 있다 — 정규식·정확 일치 라우트는 뺀다.
  const locations = [
    ...new Set(
      services
        .flatMap((e) => (e.nginx ? e.nginx.routes.map((r) => r.location) : []))
        .filter((l) => /^\//.test(l)),
    ),
  ];

  // 의존성 · 빌드: package.json 이 있는 pm2 cwd 마다. 설치 스크립트가 도는 줄이므로 lockfile 이 있으면 npm ci.
  const installs = [];
  for (const a of pm2) {
    const cwd = path.resolve(dir, a.cwd);
    if (cwd !== dir && !cwd.startsWith(`${dir}${path.sep}`)) continue;
    if (!fs.existsSync(path.join(cwd, 'package.json'))) continue;
    const rel = path.relative(config.repoRoot, cwd);
    if (installs.some((i) => i.rel === rel)) continue;
    const locked = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((f) => fs.existsSync(path.join(cwd, f)));
    installs.push({ rel, cmd: `${locked ? 'npm ci' : 'npm install'} && npm run build --if-present` });
  }

  const list = [
    {
      id: 'database',
      title: '1. 데이터베이스 (스키마가 있는 서비스만)',
      cwd: '.',
      run: `sudo ./database/setup_mariadb.sh`,
      sudo: true,
    },
    ...(installs.length
      ? [
          {
            id: 'deps',
            title: '1-1. 의존성 설치 · 빌드 (선언된 cwd 마다 — 설치 스크립트가 도니 먼저 내용을 확인하세요)',
            cwd: '.',
            run: installs.map((i) => `(cd ${i.rel} && ${i.cmd})`).join('\n'),
            sudo: false,
          },
        ]
      : []),
    {
      id: 'pm2',
      title: `2. pm2 — 이 서비스만 올린다${appNames.length > 1 ? ` (${appNames.length}개)` : ''}`,
      cwd: 'pm2',
      run: `pm2 start ecosystem.config.js --only ${(appNames.length ? appNames : [name]).join(',')} && pm2 save`,
      sudo: false,
    },
    {
      id: 'verify',
      title: '3. 떠 있는지 먼저 확인',
      cwd: '.',
      run: ports.length ? ports.map((p) => `curl -s localhost:${p}/health`).join('\n') : `# 선언에서 포트를 찾지 못했습니다`,
      sudo: false,
    },
    {
      id: 'nginx',
      title: '4. nginx — 전체 라우트를 반영한다 (마지막)',
      cwd: '.',
      run: `sudo ./nginx/install_nginx_stack.sh --skip-install`,
      sudo: true,
    },
    {
      id: 'reverify',
      title: '5. 다시 확인',
      cwd: '.',
      run: locations.length ? locations.map((l) => `curl -s -o /dev/null -w "${l} %{http_code}\\n" localhost${l}`).join('\n') : `curl -s localhost/${name}/health`,
      sudo: false,
    },
  ];

  // 이미 자기 저장소(.git)를 가진 폴더(직접 clone 한 것)에는 git init 을 권하지 않는다.
  if (track === 'plugin' && !fs.existsSync(path.join(serviceDir(name), '.git'))) {
    list.unshift({
      id: 'plugin.init',
      title: '0. 별도 저장소로 둔다 (plug-in)',
      cwd: `services/${name}`,
      run: `git init && git add -A && git commit -m "initial"`,
      sudo: false,
    });
  }

  return list;
}

module.exports = { checklist, runCheck, commands, exists };
