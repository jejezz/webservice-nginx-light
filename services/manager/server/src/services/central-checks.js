'use strict';

/**
 * 중앙 감시로 보내는 점검 항목 (id 는 중앙과 맺은 약속이라 바꾸지 않는다).
 *
 *   nginx
 *
 * light 판은 통화 시스템(janus · kamailio · coturn · websocket-relay)과 ntp 를 싣지 않으므로
 * 항목이 nginx 하나다. 중앙은 원래도 선택 서비스가 설치되지 않으면 그 항목이 빠진 채로 받으므로
 * (아래 규칙), 항목이 줄어든 것을 고장으로 보지 않는다.
 *
 * 새 점검을 만들지 않고 manager 가 이미 읽는 것을 매핑만 한다 — nginx 상태(nginx.js).
 * 기준은 central-agent 의 README 와 같다.
 *
 *   error  프로세스·포트가 죽음
 *   warn   점검 자체가 실패해 판정을 못 함
 *
 * 규칙
 *  - 점검이 예외로 실패해도 항목을 빼지 않는다 — warn + 이유로 보낸다 (조용히 사라지면 문제를 못 본다).
 *  - msg 에는 비밀번호·토큰·내부 IP·계정을 넣지 않는다. 짧은 요약만 (최대 200자).
 */

const brief = (err) => String((err && err.message) || err || 'error').replace(/\s+/g, ' ').slice(0, 120);
const failed = (id, err) => ({ id, state: 'warn', msg: `check failed: ${brief(err)}` });

function defaultDeps() {
  // 지연 require — 시험이 가짜 deps 만 넘길 때 config/DB 를 끌어오지 않게 한다.
  const nginx = require('./nginx');
  return {
    nginxStatus: () => nginx.status(),
  };
}

/** 모든 항목을 모은다. 항목 하나가 던져도 나머지는 계속한다. */
async function collect(deps = defaultDeps()) {
  const out = [];
  const add = async (id, fn) => {
    try {
      const item = await fn();
      if (item) out.push(item);
    } catch (err) {
      out.push(failed(id, err));
    }
  };

  await add('nginx', async () => {
    const s = await deps.nginxStatus();
    return s.active ? { id: 'nginx', state: 'ok' } : { id: 'nginx', state: 'error', msg: `process not running (${String(s.state).slice(0, 30)})` };
  });

  return out;
}

module.exports = { collect };
