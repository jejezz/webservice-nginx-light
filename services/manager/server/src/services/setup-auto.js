const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../config');
const log = require('../logger');
const checkRunner = require('./check-runner');
const settings = require('./setup-settings');
const shared = require(path.join(config.repoRoot, 'lib', 'settings'));

/**
 * 구축 마법사의 "자동으로 실행".
 *
 * 마법사는 원래 바꾸는 명령을 대신 돌리지 않았다(docs/guide/install.md '8.'). 이 모듈은
 * 그 경계를 **사용자가 단계마다 골랐을 때만** 넘는다. 경계가 풀린 만큼 다른 쪽을 좁게 잡았다:
 *
 *   1. 돌리는 것은 setup.js 의 STEPS 표에 박힌 `auto.commands` 뿐이다. 사람이 보낸
 *      문자열로 명령을 만들지 않는다. 요청이 정하는 것은 :stepId 와 sudo 비밀번호뿐이다.
 *   2. 셸을 거치지 않는다(spawn + argv). cwd 는 저장소 안으로 한정한다.
 *   3. 한 번에 작업 하나만 돈다.
 *   4. sudo 비밀번호는 **메모리에만** 둔다. 디스크에 쓰지 않고, 로그에 남지 않게 걸러 내고,
 *      작업이 끝나면 버린다. 아래 '비밀번호 전달' 참고.
 *
 * ── 비밀번호 전달 ────────────────────────────────────────────────
 * 스크립트들은 안에서 직접 `sudo` 를 부른다(install_nginx_stack.sh 등). stdin 으로 넘기는
 * `sudo -S` 는 그 안쪽 호출에 닿지 못한다. 그래서 작업마다 0700 임시 폴더를 만들고
 *   - `sudo` 라는 이름의 래퍼(`/usr/bin/sudo -A "$@"`)를 PATH 맨 앞에 둔다
 *   - SUDO_ASKPASS 는 같은 폴더의 유닉스 소켓에 연결해 비밀번호를 받아 오는 작은 헬퍼다
 * 비밀번호는 소켓으로만 오가고 파일·환경 변수·인자에 실리지 않는다. 폴더는 작업이 끝나면 지운다.
 *
 * DB 관리자 접속 정보(root 가 unix_socket 이 아니라 비밀번호 인증인 장비)는 같은 폴더의
 * 0600 옵션 파일로 둔다. sudo 가 환경 변수를 지우므로 `sudo` 래퍼가 그 파일 **경로만**
 * `sudo env MARIADB_ADMIN_DEFAULTS_FILE=… 명령` 으로 끼워 넘기고, database/lib_mariadb.sh 가
 * 그것을 가장 먼저 시도한다. 비밀번호는 경로가 가리키는 파일 안에만 있다.
 */

const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LINES = 5000;
const MAX_LINE_LENGTH = 2000;
const MAX_PASSWORD_LENGTH = 256;

/** @type {Map<string, object>} stepId → 가장 최근 작업 */
const jobs = new Map();
let running = null;

class AutoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function repoPath(rel) {
  const root = config.repoRoot.endsWith(path.sep) ? config.repoRoot.slice(0, -1) : config.repoRoot;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new AutoError('path_escapes_repo', `저장소 밖입니다: ${rel}`);
  }
  return abs;
}

// argv 안의 자리표시자. 값은 **저장된 사이트 설정**에서 읽는다 — 요청이 정하는 값이 아니다.
const SITE_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function siteValue(key) {
  try {
    const ini = shared.parseIni(fs.readFileSync(path.join(config.repoRoot, 'site', 'settings.ini'), 'utf8'));
    return String(ini[key] || '').trim();
  } catch {
    return '';
  }
}

/** `{{site.host}}` 를 사이트 설정 값으로 바꾼다. 값이 없거나 모양이 틀리면 던진다 (옵션으로 읽힐 수 있는 값을 막는다). */
function resolveArg(arg) {
  if (arg !== '{{site.host}}') return arg;
  const host = siteValue('host');
  if (!host) throw new AutoError('settings_missing', '먼저 1단계(site.settings)에서 host 를 저장하세요.');
  if (!SITE_HOST_RE.test(host)) throw new AutoError('settings_invalid', `사이트 설정의 host 형식이 올바르지 않습니다: ${host}`);
  return host;
}

function resolvedArgv(c) {
  return c.argv.map(resolveArg);
}

/** 단계의 자동 실행 정의를 화면에 보낼 모양으로. 정의가 없으면 이유를 돌려준다. */
function describe(step) {
  const auto = step.auto;
  if (!auto || !Array.isArray(auto.commands) || auto.commands.length === 0) {
    return { available: false, reason: (auto && auto.reason) || '이 단계는 자동 실행이 정의되어 있지 않습니다.' };
  }
  const commands = auto.commands.map((c) => ({
    cwd: c.cwd || '.',
    text: `${c.sudo ? 'sudo ' : ''}${c.argv.map((a) => { try { return resolveArg(a); } catch { return a; } }).join(' ')}`,
    sudo: Boolean(c.sudo),
  }));
  return {
    available: true,
    needsSudo: commands.some((c) => c.sudo),
    // root 가 비밀번호 인증인 장비에서 DB 관리자 접속 정보를 받는 단계 (아래 '비밀번호 전달')
    needsDbAdmin: Boolean(auto.needsDbAdmin),
    // nginx 설정을 반영해 이 화면의 주소(http → https)가 바뀔 수 있는 단계
    changesOrigin: Boolean(auto.changesOrigin),
    commands,
  };
}

// ── 비밀번호 전달 (sudo 래퍼 + askpass 소켓) ─────────────────────────────

const ASKPASS_JS = `'use strict';
const net = require('net');
const path = require('path');
const sock = net.connect(path.join(__dirname, 's.sock'));
sock.on('connect', () => sock.write((process.env.MANAGER_ASKPASS_TOKEN || '') + '\\n'));
let buf = '';
sock.on('data', (d) => { buf += d.toString('utf8'); });
sock.on('end', () => { process.stdout.write(buf + '\\n'); process.exit(buf ? 0 : 1); });
sock.on('error', () => process.exit(1));
`;

function startAskpass(password, dbAdmin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-auto-'));
  fs.chmodSync(dir, 0o700);
  const token = crypto.randomBytes(24).toString('hex');

  fs.writeFileSync(path.join(dir, 'askpass.js'), ASKPASS_JS, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, 'askpass.sh'),
    `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'askpass.js')}'\n`,
    { mode: 0o700 },
  );
  // 이름이 sudo 인 래퍼. 스크립트 안의 `sudo ...` 가 이것을 먼저 만난다.
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { mode: 0o700 });
  // DB 관리자 접속 정보. 값에서 \ 와 " 를 이스케이프해 옵션 파일의 큰따옴표 값으로 쓴다.
  let sudoScript = '#!/bin/sh\nexec /usr/bin/sudo -A "$@"\n';
  if (dbAdmin) {
    const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const cnf = path.join(dir, 'mariadb-admin.cnf');
    fs.writeFileSync(cnf, `[client]\nuser=${q(dbAdmin.user)}\npassword=${q(dbAdmin.password)}\n`, { mode: 0o600 });
    // -v · -k 같은 옵션만 오는 호출에는 끼우지 않는다.
    sudoScript =
      '#!/bin/sh\n' +
      'case "$1" in -*) exec /usr/bin/sudo -A "$@" ;; esac\n' +
      `exec /usr/bin/sudo -A env MARIADB_ADMIN_DEFAULTS_FILE='${cnf}' "$@"\n`;
  }
  fs.writeFileSync(path.join(binDir, 'sudo'), sudoScript, { mode: 0o700 });

  const server = net.createServer((conn) => {
    let got = '';
    conn.setTimeout(5000, () => conn.destroy());
    conn.on('data', (d) => {
      got += d.toString('utf8');
      if (!got.includes('\n')) return;
      const supplied = Buffer.from(got.split('\n')[0]);
      const expected = Buffer.from(token);
      const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      conn.end(ok ? password : '');
    });
    conn.on('error', () => {});
  });
  server.listen(path.join(dir, 's.sock'));
  try { fs.chmodSync(path.join(dir, 's.sock'), 0o600); } catch { /* listen 이 비동기라 늦을 수 있다 — 폴더가 이미 0700 */ }

  return {
    sudoPath: path.join(binDir, 'sudo'),
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      SUDO_ASKPASS: path.join(dir, 'askpass.sh'),
      MANAGER_ASKPASS_TOKEN: token,
    },
    close() {
      try { server.close(); } catch { /* 이미 닫힘 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── 작업 ─────────────────────────────────────────────────────────────

function snapshot(job, from = 0) {
  return {
    id: job.id,
    stepId: job.stepId,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    current: job.current,
    total: job.total,
    failedCommand: job.failedCommand || null,
    exitCode: job.exitCode ?? null,
    truncated: job.truncated,
    from,
    next: job.lines.length,
    lines: job.lines.slice(from),
  };
}

function pushLine(job, text, stream) {
  let line = text;
  for (const secret of job.secrets || []) {
    if (secret && secret.length >= 4) line = line.split(secret).join('***');
  }
  if (line.length > MAX_LINE_LENGTH) line = `${line.slice(0, MAX_LINE_LENGTH)} …`;
  if (job.lines.length >= MAX_LINES) {
    job.truncated = true;
    return;
  }
  job.lines.push({ stream, text: line });
}

function pipeLines(job, readable, stream) {
  let rest = '';
  readable.on('data', (chunk) => {
    rest += chunk.toString('utf8');
    const parts = rest.split(/\r?\n/);
    rest = parts.pop();
    for (const p of parts) pushLine(job, p, stream);
  });
  readable.on('end', () => {
    if (rest) pushLine(job, rest, stream);
  });
}

function runOne(job, cmd) {
  return new Promise((resolve) => {
    const cwd = repoPath(cmd.cwd || '.');
    const env = { ...checkRunner.childEnv(), ...(job.askpass ? job.askpass.env : {}) };
    const resolved = resolvedArgv(cmd);
    const argv = cmd.sudo ? [job.askpass.sudoPath, ...resolved] : resolved;

    pushLine(job, `$ ${cmd.sudo ? 'sudo ' : ''}${resolved.join(' ')}   (cd ${cmd.cwd || '.'})`, 'cmd');

    // 새 세션(detached) — 제어 터미널이 없어야 sudo 가 askpass 를 쓰고, 취소할 때
    // 프로세스 그룹째 끝낼 수 있다.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    job.child = child;

    pipeLines(job, child.stdout, 'out');
    pipeLines(job, child.stderr, 'err');

    const timer = setTimeout(() => {
      pushLine(job, `${COMMAND_TIMEOUT_MS / 60000}분을 넘겨 중단합니다.`, 'err');
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 끝남 */ }
    }, COMMAND_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      pushLine(job, `실행하지 못했습니다: ${err.message}`, 'err');
      resolve(127);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      job.child = null;
      resolve(code === null ? (signal ? 128 : 1) : code);
    });
  });
}

async function execute(job, commands) {
  try {
    for (let i = 0; i < commands.length; i += 1) {
      if (job.cancelled) break;
      job.current = i + 1;
      const code = await runOne(job, commands[i]);
      if (job.cancelled) break;
      if (code !== 0 && !commands[i].allowFail) {
        job.status = 'failed';
        job.exitCode = code;
        job.failedCommand = `${commands[i].sudo ? 'sudo ' : ''}${commands[i].argv.join(' ')}`;
        return;
      }
      if (code !== 0) pushLine(job, `(종료 코드 ${code} — 이 명령은 실패해도 계속합니다)`, 'cmd');
    }
    job.status = job.cancelled ? 'cancelled' : 'ok';
  } catch (err) {
    pushLine(job, `오류: ${err.message}`, 'err');
    job.status = 'failed';
  } finally {
    job.endedAt = new Date().toISOString();
    job.secrets = [];
    if (job.askpass) job.askpass.close();
    job.askpass = null;
    if (running === job) running = null;
    log.info(`구축 마법사 자동 실행 ${job.stepId}: ${job.status} (${job.by})`);
  }
}

/**
 * 시작한다. step 은 STEPS 표의 한 줄이다(호출자가 :stepId 로 골라 온다).
 * 비밀번호가 필요하면 먼저 `sudo -A -v` 로 맞는지 확인하고, 틀리면 아무것도 돌리지 않는다.
 */
async function start(step, { sudoPassword, dbAdminUser, dbAdminPassword, by }) {
  const info = describe(step);
  if (!info.available) throw new AutoError('auto_unavailable', info.reason);
  // 이 장비의 값이 비어 있으면 스크립트는 "설치할 수 없습니다" 로 끝난다. 돌리기 전에 막고
  // 무엇을 채워야 하는지 말한다 (설정 폼은 같은 단계 카드 위에 있다).
  const missing = settings.missingFor(step);
  if (missing.length) {
    throw new AutoError('settings_missing', `먼저 위의 설정 폼에서 채우고 저장하세요: ${missing.join(', ')}`);
  }
  if (running) throw new AutoError('busy', `다른 자동 실행이 돌고 있습니다: ${running.stepId}`);

  const commands = step.auto.commands;
  for (const c of commands) resolvedArgv(c);   // 값이 없거나 틀리면 시작 전에 던진다
  let askpass = null;

  if (info.needsSudo) {
    if (typeof sudoPassword !== 'string' || !sudoPassword) {
      throw new AutoError('sudo_password_required', 'sudo 비밀번호가 필요합니다.');
    }
    if (sudoPassword.length > MAX_PASSWORD_LENGTH) {
      throw new AutoError('sudo_password_invalid', '비밀번호가 너무 깁니다.');
    }
  }

  // DB 관리자 접속 정보는 선택이다 — root 가 socket 인증이면 필요 없다. 넣었다면 둘 다 있어야 한다.
  let dbAdmin = null;
  if (info.needsDbAdmin && (dbAdminUser || dbAdminPassword)) {
    if (typeof dbAdminUser !== 'string' || typeof dbAdminPassword !== 'string' || !dbAdminUser || !dbAdminPassword) {
      throw new AutoError('db_admin_incomplete', 'DB 관리자 계정과 비밀번호를 둘 다 넣어야 합니다.');
    }
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(dbAdminUser)) {
      throw new AutoError('db_admin_invalid', 'DB 관리자 계정 이름은 영문·숫자·_ . - 만, 32자까지입니다.');
    }
    if (dbAdminPassword.length > MAX_PASSWORD_LENGTH || /[\r\n\0]/.test(dbAdminPassword)) {
      throw new AutoError('db_admin_invalid', 'DB 관리자 비밀번호에 줄바꿈이 있거나 너무 깁니다.');
    }
    dbAdmin = { user: dbAdminUser, password: dbAdminPassword };
  }

  if (info.needsSudo) askpass = startAskpass(sudoPassword, dbAdmin);

  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    stepId: step.id,
    by,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    current: 0,
    total: commands.length,
    lines: [],
    truncated: false,
    cancelled: false,
    child: null,
    secrets: [],
    askpass,
  };
  job.secrets = [info.needsSudo ? sudoPassword : null, dbAdmin ? dbAdmin.password : null].filter(Boolean);
  running = job;
  jobs.set(step.id, job);

  if (info.needsSudo) {
    // 비밀번호가 맞는지 먼저 본다. 틀린 채로 긴 작업을 시작하지 않기 위해서다.
    const code = await runOne(job, { cwd: '.', argv: ['-v'], sudo: true });
    if (code !== 0) {
      job.status = 'failed';
      job.exitCode = code;
      job.failedCommand = 'sudo -v';
      pushLine(job, 'sudo 비밀번호가 맞지 않거나 이 계정에 sudo 권한이 없습니다.', 'err');
      job.endedAt = new Date().toISOString();
      job.secrets = [];
      askpass.close();
      job.askpass = null;
      running = null;
      return snapshot(job);
    }
  }

  log.info(`구축 마법사 자동 실행 시작 ${step.id} (${by})`);
  // 기다리지 않는다 — 화면이 진행을 읽어 간다.
  execute(job, commands);
  return snapshot(job);
}

function status(stepId, from = 0) {
  const job = jobs.get(stepId);
  return job ? snapshot(job, from) : null;
}

function cancel(stepId) {
  const job = jobs.get(stepId);
  if (!job || job.status !== 'running') return false;
  job.cancelled = true;
  if (job.child) {
    try { process.kill(-job.child.pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
  }
  return true;
}

function runningStepId() {
  return running ? running.stepId : null;
}

module.exports = { AutoError, describe, start, status, cancel, runningStepId };
