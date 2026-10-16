'use strict';

const { runScript, parseReport } = require('./check-runner');
const setup = require('./setup');
const setupAuto = require('./setup-auto');

/**
 * 저장소 뿌리의 ./check-all.sh 를 줄 하나씩 돌려 화면에 넘긴다.
 *
 * 판정은 여기서 내리지 않는다. check-all.sh 가 `--list-json`(줄 목록)과 `--one N --json`(한 줄의
 * 결과)을 내고, 이 모듈은 그것을 읽어 전달할 뿐이다 — 터미널의 ./check-all.sh 와 화면이 같은
 * 판정을 보는 것이 이 구조의 목적이다. 화면은 **번호만** 보내고 명령은 보내지 않으므로, 스크립트의
 * 표에 없는 명령은 돌릴 수 없다. 돌리는 것은 전부 읽기 전용이다 (check-all.sh 머리말).
 */

const LIST_TIMEOUT_MS = 15000;
// check-all.sh 의 줄당 TIMEOUT(120초)보다 넉넉하게 둔다 — 안쪽이 먼저 끊고 'timeout' 으로 보고하게.
const ONE_TIMEOUT_MS = 130000;

const STATUSES = new Set(['ok', 'problem', 'pending', 'optional', 'unreadable', 'timeout']);

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function list() {
  const r = await runScript({ cwd: '.', file: './check-all.sh', args: ['--list-json'], timeoutMs: LIST_TIMEOUT_MS });
  const data = parseJson(r.stdout);
  if (!data || !Array.isArray(data.checks)) {
    throw new Error(r.spawnError ? `check-all.sh 를 실행하지 못했습니다 (${r.spawnError})` : 'check-all.sh 의 목록을 읽지 못했습니다.');
  }
  return data.checks.map((c) => ({
    id: Number(c.id),
    label: String(c.label),
    optional: Boolean(c.optional),
    step: c.step ? String(c.step) : null,
  }));
}

/**
 * 점검 화면에만 있는 반영. 구축 마법사의 단계로는 그 줄을 고치는 일을 나타낼 수 없는 곳이다.
 *
 * light 판에는 이런 줄이 없어 비어 있다. 서비스를 붙였는데 점검 줄이 어긋나는 흔한 이유가
 * 'dist/ 가 src/ 보다 오래됨' 처럼 빌드와 재시작이면 되는 일이라면 여기에 둔다.
 * 단계 전체를 사람 몫으로 두면 한 줄이면 되는 일까지 터미널로 돌려보내게 되기 때문이다.
 *
 *   '<단계 id>': {
 *     id: '<단계 id>',
 *     auto: { commands: [{ cwd, argv }] },
 *     gate: { note, refusal, check: { cwd, file, args } },   // 선택 — 반영 직전의 확인
 *   }
 *
 * 재시작은 깨진 설정을 서비스에 먹일 수 있으므로, 그런 서비스에는 **gate** 를 둔다: 반영 직전에
 * 서버가 그 서비스의 설정 점검만 따로 돌려, 온전하지 않으면 시작하지 않는다.
 *
 * 마법사 STEPS 와 섞지 않는다 — 마법사 화면에 새 자동 실행이 생기면 구축 절차가 바뀐다. 줄 ↔ 이 표의 연결도
 * check-all.sh 의 줄 옆(다섯째 칸)에 적는다. 명령은 여기 박힌 것뿐이다.
 */
const CHECK_ONLY = {};

/**
 * 이 점검 줄을 고치는 단계. 줄 → 단계 연결은 check-all.sh 의 표가 갖는다 (거기서 줄 옆에 적는다).
 * 점검 전용 표(CHECK_ONLY) 먼저, 없으면 구축 마법사 STEPS. 둘 다 아니면 null — 화면은 반영을 내밀지 않는다.
 */
function stepFor(check) {
  if (!check.step) return null;
  return CHECK_ONLY[check.step] || setup.find(check.step) || null;
}

/**
 * 화면에 보낼 '반영' 설명. 명령은 단계 표(setup.js AUTO)의 것이라 사람이 보낸 문자열이 아니다.
 * 반영할 수 없으면(단계 없음 · 자동 실행 없음) available:false 와 이유를 돌려준다.
 */
function applyInfo(check) {
  const step = stepFor(check);
  if (!step) return { available: false, reason: null };
  const info = setupAuto.describe(step);
  return step.gate && info.available ? { ...info, note: step.gate.note } : info;
}

/**
 * 반영 직전의 확인. 단계에 gate 가 없으면 항상 통과다.
 * 점검을 읽지 못한 것도 통과시키지 않는다 — 확인하지 못한 채 서비스를 재시작하지 않는다.
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
async function gate(step) {
  if (!step.gate) return { ok: true };

  const r = await runScript({ ...step.gate.check, timeoutMs: 60000 });
  const report = parseReport(r.stdout);
  if (!report || !report.state) {
    return { ok: false, message: `${step.gate.refusal} (설정 점검을 읽지 못했습니다${r.stderr ? `: ${r.stderr}` : ''})` };
  }
  if (report.state === 'complete') return { ok: true };

  const why = report.checks.filter((c) => c.level === 'problem' || c.level === 'pending').map((c) => c.text);
  return { ok: false, message: `${step.gate.refusal}: ${why.slice(0, 3).join(' / ')}` };
}

/** 목록 + 줄마다 반영 설명. */
async function listWithApply() {
  return (await list()).map((c) => ({ ...c, apply: applyInfo(c) }));
}

/** 번호로 줄 하나 (반영 요청이 어느 단계를 가리키는지 서버가 정한다). */
async function find(id) {
  return (await list()).find((c) => c.id === id) || null;
}

// 같은 줄을 동시에 두 번 돌리지 않는다 — 새로 고침 연타나 두 사람이 동시에 열었을 때 같은 점검이
// 겹쳐 서로를 느리게 만든다. 이미 도는 중이면 그 결과를 같이 받는다.
const inFlight = new Map();

function runOne(id) {
  if (inFlight.has(id)) return inFlight.get(id);

  const p = (async () => {
    const r = await runScript({
      cwd: '.',
      file: './check-all.sh',
      args: ['--one', String(id), '--json'],
      timeoutMs: ONE_TIMEOUT_MS,
    });

    const data = parseJson(r.stdout);
    if (!data || !STATUSES.has(data.status)) {
      // 줄 번호 오류(종료 코드 2)는 stderr 에 이유가 있다.
      const why = r.timedOut ? '시간 안에 끝나지 않았습니다.' : r.stderr || '결과를 읽지 못했습니다.';
      const err = new Error(why);
      err.status = r.exitCode === 2 ? 404 : 502;
      throw err;
    }

    return {
      id,
      label: String(data.label),
      status: data.status,
      fix: String(data.fix || ''),
      lines: Array.isArray(data.lines) ? data.lines.map(String) : [],
      durationMs: r.durationMs,
      checkedAt: new Date().toISOString(),
    };
  })().finally(() => inFlight.delete(id));

  inFlight.set(id, p);
  return p;
}

module.exports = { list, listWithApply, find, stepFor, gate, runOne };
