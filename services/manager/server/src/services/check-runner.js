const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

/**
 * services/setup.js 에서 뽑아낸, 저장소 안의 점검 스크립트를 안전하게 돌리는
 * 공용 실행기. 서비스 추가 마법사(services/register.js)도 같은 규약으로
 * 돌아야 하므로(docs/guide/contracts.md '점검 규약') 여기 한 곳에 모았다.
 *
 * 경계는 setup.js 가 원래 지키던 것과 같다:
 *
 *   1. 호출자가 넘긴 spec 의 cwd/file 이 저장소 밖을 가리키면 던진다.
 *   2. 셸을 거치지 않는다 (execFile). 타임아웃과 출력 상한을 둔다.
 *   3. manager 자신의 pm2 [env] 를 자식에게 물려주지 않는다 — 아래
 *      ENV_PASSTHROUGH 주석 참고.
 *
 * --apply/--install 처럼 무언가를 바꾸는 모드를 절대 돌리지 않는 것은
 * **호출자의 책임**이다(spec.args 를 정하는 쪽). 이 모듈 자체는 "무엇을
 * 도는지" 를 모른다 — 그것까지 검사하면 setup.js 전용이 되어 새 호출자를
 * 받을 수 없다.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_MESSAGES',
  'TZ',
  'TERM', 'TMPDIR',
];

function childEnv() {
  const env = {};
  for (const key of ENV_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const STATES = new Set(['complete', 'incomplete', 'problem']);
const LEVELS = new Set(['ok', 'skip', 'pending', 'problem']);

/**
 * 실행할 파일과 작업 디렉터리를 저장소 안으로 한정해 만든다.
 * spec: { cwd, file, args, interpreter?: 'node', timeoutMs? }
 */
function resolveSpec(spec) {
  const cwd = path.resolve(config.repoRoot, spec.cwd);
  const script = path.resolve(cwd, spec.file);

  // 저장소 루트 자신도 안쪽이다 — 접두사 비교만 하면 cwd: '.' 이 걸린다.
  const root = config.repoRoot.endsWith(path.sep) ? config.repoRoot.slice(0, -1) : config.repoRoot;
  const inside = (p) => p === root || p.startsWith(`${root}${path.sep}`);

  if (!inside(script) || !inside(cwd)) {
    throw new Error(`check path escapes repo root: ${script}`);
  }

  if (spec.interpreter === 'node') {
    return { cwd, file: process.execPath, args: [spec.file, ...spec.args] };
  }
  return { cwd, file: spec.file, args: spec.args };
}

/** 화면에 보여 줄 점검 명령. 실행은 resolveSpec 이 만든 것으로만 한다. */
function commandText(spec) {
  const prefix = spec.interpreter === 'node' ? 'node ' : '';
  return `${prefix}${path.join(spec.cwd, spec.file)} ${spec.args.join(' ')}`;
}

/** docs/guide/contracts.md 'state 계산' 의 규칙 그대로 checks 에서 판정을 다시 계산한다. */
function deriveState(checks) {
  if (checks.some((c) => c.level === 'problem')) return 'problem';
  if (checks.some((c) => c.level === 'pending')) return 'incomplete';
  return 'complete';
}

/** stdout 한 덩어리를 규약대로 읽는다. 읽지 못하면 null 을 돌려준다. */
function parseReport(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.checks)) return null;

  const checks = [];
  for (const entry of data.checks) {
    if (!entry || typeof entry !== 'object') continue;
    const level = LEVELS.has(entry.level) ? entry.level : null;
    if (!level) return null; // 모르는 레벨이 있으면 판정하지 않는다
    checks.push({ level, text: String(entry.text ?? '') });
  }

  return {
    step: typeof data.step === 'string' ? data.step : '',
    state: STATES.has(data.state) ? data.state : null,
    checks,
  };
}

function runScript(spec) {
  const { cwd, file, args } = resolveSpec(spec);

  return new Promise((resolve) => {
    const startedAt = Date.now();

    execFile(
      file,
      args,
      {
        cwd,
        timeout: spec.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        env: childEnv(),
      },
      (err, stdout, stderr) => {
        resolve({
          // 점검이 문제를 찾으면 종료 코드가 1 이다. 그것은 실패가 아니라 결과다.
          exitCode: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          timedOut: Boolean(err && err.killed),
          spawnError: err && typeof err.code === 'string' ? err.code : null,
          stdout: stdout || '',
          stderr: (stderr || '').trim(),
          durationMs: Date.now() - startedAt,
        });
      }
    );
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  resolveSpec,
  commandText,
  deriveState,
  parseReport,
  runScript,
  childEnv,
};
