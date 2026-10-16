'use strict';

/**
 * 중앙 감시 (webservice-central-server) 에이전트.
 *
 * 에이전트 본체는 vendor/central-agent.mjs — central 저장소의 agent/ 를 **그대로 복사**한 한 파일이다. 고치지 않고,
 * 우회하지 않는다 (직접 fetch 하지 않고, 모듈 안의 검사를 약화하지 않는다).
 * ESM 이라 CommonJS 인 이 앱에서는 동적 import 로 불러온다 (Node 20+, fs.statfs·fetch 필요).
 *
 * ── 서버 주소 규칙 (central 저장소 docs/API.md '등록 코드 형식과 서버 주소 규칙') ──
 * 서버 주소는 **등록 코드의 마지막 조각에서만** 얻는다. 이 앱에는 기본 서버 주소도, 주소를 넣는 입력칸·환경 변수·설정도 없다.
 * 관리자가 등록하지 않았으면 설정은 비어 있고 모듈은 아무것도 보내지 않는다. 등록은 agent.enroll(code) 로만 하고,
 * 주소가 바뀌면 새 코드로 다시 enroll() 해서 덮어쓴다 (주소를 손으로 고치는 기능은 없다). HTTPS 가 아닌 주소는 모듈이 거절한다.
 *
 * 등록 코드와 siteSecret 은 로그·화면·오류 메시지·API 응답에 싣지 않는다. 이 모듈이 내는 status 에는 현장 ID 와
 * 마지막 전송 결과만 있다. siteSecret 은 central.json (권한 600, git 제외) 에만 있다.
 */

const path = require('path');
const log = require('../logger');
const { collect } = require('./central-checks');
const cert = require('./cert');
const { loadServices } = require('./registry');
const pkg = require('../../package.json');

const STORE_PATH = process.env.MANAGER_CENTRAL_STORE
  ? path.resolve(process.env.MANAGER_CENTRAL_STORE)
  : path.resolve(__dirname, '..', '..', '..', 'central.json');

let loaded = null; // { mod, agent }

async function get() {
  if (loaded) return loaded;
  const mod = await import('../vendor/central-agent.mjs');
  const agent = new mod.CentralAgent({
    store: mod.fileStore(STORE_PATH),
    collectChecks: () => collect(),
    getCertMinDays: async () => {
      const c = await cert.status(loadServices().server);
      return c.ok && Number.isInteger(c.daysLeft) ? c.daysLeft : undefined;
    },
    versions: { manager: pkg.version },
    log: (level, msg) => (log[level] || log.info)(`[central] ${msg}`),
  });
  loaded = { mod, agent };
  return loaded;
}

/**
 * manager 시작 때. 등록돼 있으면 보고를 시작하고, 등록 전이면 모듈이 아무것도 보내지 않고 기다린다
 * (이후 enroll() 이 성공하는 순간부터 매시간 보고). 실패해도 manager 는 뜬다.
 */
async function startIfEnrolled() {
  try {
    const { agent } = await get();
    await agent.start();
  } catch (err) {
    log.warn(`[central] start failed: ${err.message}`);
  }
}

function stop() {
  loaded?.agent.stop();
}

/** 설정 화면용: 등록 여부, 현장 ID, 마지막 전송 결과. 서버 주소·등록 코드·siteSecret 은 싣지 않는다. */
async function status() {
  const { agent } = await get();
  const enrolled = await agent.isEnrolled();
  const config = enrolled ? await agent.store.load() : null;
  return {
    enrolled,
    running: agent.running,
    site: config ? { siteId: config.siteId } : null,
    last: agent.last,
  };
}

/** 등록 코드로 등록한다 (agent.enroll). 오류는 AgentError(code) 로 던진다. 성공하면 정기 보고가 돈다. */
async function enroll(code) {
  const { agent } = await get();
  const outcome = await agent.enroll(code);
  if (!agent.running) await agent.start();
  return outcome;
}

async function sendNow() {
  const { agent } = await get();
  return agent.sendOnce();
}

async function isAgentError(err) {
  const { mod } = await get();
  return err instanceof mod.AgentError;
}

module.exports = { startIfEnrolled, stop, status, enroll, sendNow, isAgentError, STORE_PATH };
