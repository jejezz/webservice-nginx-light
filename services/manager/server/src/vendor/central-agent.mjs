// 현장 보고 에이전트 (Node 모듈). nginx manager 같은 현장 앱 안에서 돌린다 (docs/DESIGN.md §3, §5.1, §6, §7).
// 의존성 없음: Node 20+ 내장 기능만 쓴다 (crypto, fetch, os, fs.statfs). OS 에 의존하지 않는다 (Linux 가 아니어도 동작하고, 못 읽는 지표는 뺀다).
// manager 가 이 파일을 복사해 가져가 쓴다. 프로토콜은 docs/API.md 가 기준이고 이 파일은 그 클라이언트 구현이다.
//
//   import { CentralAgent, fileStore } from './central-agent.mjs';
//   const agent = new CentralAgent({
//     store: fileStore('/var/lib/manager/central.json'),   // 또는 manager 자신의 설정 저장소
//     collectChecks: async () => [{ id: 'nginx', state: 'ok' }, { id: 'db', state: 'warn', msg: 'replica lag 12s' }],
//     getCertMinDays: async () => 41,                      // 선택
//     versions: { manager: '1.8.2' },
//   });
//   await agent.enroll(codeFromAdmin);   // 등록 코드(1회용). 성공하면 설정이 저장되고 첫 보고를 보낸다.
//   await agent.start();                 // 등록돼 있으면: 바로 한 번 보내고(배경) 매시간 보낸다. 등록 전이면 아무것도 보내지 않고 기다린다.
import { createHash, createHmac } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { dirname, parse as parsePath } from 'node:path';
import os from 'node:os';

export const AGENT_VERSION = '2.2.0';

const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CODE_RE = /^wsc1\.([a-z0-9][a-z0-9-]{1,62})\.([0-9a-f]{48})\.([A-Za-z0-9_-]{1,300})$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CHECKS = 50;
/** 재시도 간격(초): 60, 120, 240, 480. 최대 5번 시도하고 다음 정기 보고 시각을 넘기지 않는다 */
const RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 480_000];
const JITTER_MS = 30_000;

/** 오류에 `code` 가 붙는다: invalid_code, rate_limited, network, server_error, invalid_response, not_configured, invalid_config */
export class AgentError extends Error {
  constructor(code, message, http) {
    super(message ?? code);
    this.name = 'AgentError';
    this.code = code;
    this.http = http;
  }
}

/**
 * 설정 저장소 (siteSecret 포함). manager 가 자기 설정 저장소를 쓰려면 `{ load, save }` 를 직접 넘긴다.
 * 파일 저장소는 권한 600 으로 쓰고 임시 파일에 쓴 뒤 바꿔치기해서 중간에 끊겨도 깨지지 않는다.
 */
export function fileStore(path) {
  return {
    async load() {
      try {
        return JSON.parse(await fsp.readFile(path, 'utf8'));
      } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async save(config) {
      await fsp.mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(config)}\n`, { mode: 0o600 });
      await fsp.rename(tmp, path);
    },
  };
}

/** 등록 코드를 해석한다. 형식이 틀리면 null. 코드 안의 서버 주소는 base64url. */
export function parseEnrollCode(code) {
  const m = CODE_RE.exec(String(code).trim());
  if (!m) return null;
  let url;
  try {
    url = Buffer.from(m[3], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return { siteId: m[1], serverUrl: url };
}

/** 서명: hex( HMAC-SHA256( siteSecret, timestamp + "." + sha256hex(body) ) ) — docs/API.md */
export function sign(siteSecret, timestamp, bodyBytes) {
  const hash = createHash('sha256').update(bodyBytes).digest('hex');
  return createHmac('sha256', siteSecret).update(`${timestamp}.${hash}`).digest('hex');
}

/** 현장마다 고정된 보고 시각(매시 정각 뒤 분·초). 현장 ID 해시라서 현장들이 한꺼번에 몰리지 않는다. */
export function reportOffsetMs(siteId) {
  const n = createHash('sha256').update(siteId).digest().readUInt32BE(0);
  const min = n % 60;
  const sec = Math.floor(n / 60) % 60;
  return (min * 60 + sec) * 1000;
}

/** 다음 보고 시각(ms). 매시 오프셋 지점 중 `nowMs` 이후 가장 가까운 곳 + ±30초 지터. */
export function nextReportAt(siteId, nowMs, jitter = (Math.random() * 2 - 1) * JITTER_MS) {
  const offset = reportOffsetMs(siteId);
  let t = Math.floor(nowMs / HOUR_MS) * HOUR_MS + offset;
  while (t - JITTER_MS <= nowMs) t += HOUR_MS;
  return t + jitter;
}

/** 관리자가 등록한(서버 주소·현장 ID·키가 모두 있는) 설정인지. 비어 있거나 일부만 있으면 아무것도 보내지 않는다. */
const isConfigured = (c) => !!(c && typeof c.serverUrl === 'string' && c.serverUrl.trim() && SITE_ID_RE.test(c.siteId ?? '') && SECRET_RE.test(c.siteSecret ?? ''));

const clean = (s, max) => String(s).replace(/[^\x20-\x7e -￿]/g, '').slice(0, max);

/**
 * 인증서 남은 일수를 점검 항목으로 바꾼다. 만료가 임박하면 일반 점검 항목처럼 알림이 간다.
 * 기준(기본): 5일 이하(만료 포함) error, 14일 이하 warn. Let's Encrypt + certbot 은 30일 남았을 때 갱신을 시작하므로,
 * 14일 밑으로 내려갔다면 자동 갱신이 2주 넘게 실패하고 있다는 뜻이다. 수동 갱신 인증서라면 더 일찍 알리도록 키운다.
 */
export function certCheck(daysLeft, { warnDays = 14, errorDays = 5 } = {}) {
  const msg = daysLeft <= 0 ? `expired ${-daysLeft} days ago` : `${daysLeft} days left`;
  const state = daysLeft <= errorDays ? 'error' : daysLeft <= warnDays ? 'warn' : 'ok';
  return { id: 'cert', state, msg };
}

/** manager 의 점검 결과를 보고 형식으로 정리한다. 잘못된 항목은 버리고 `overall` 은 항목 중 가장 나쁜 상태. */
export function normalizeChecks(raw) {
  const checks = [];
  let overall = 'ok';
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c.id !== 'string' || !['ok', 'warn', 'error'].includes(c.state)) continue;
    const id = clean(c.id, 64);
    if (!id) continue;
    const item = { id, state: c.state };
    const msg = typeof c.msg === 'string' ? clean(c.msg, 200) : '';
    if (msg) item.msg = msg;
    checks.push(item);
    if (c.state === 'error') overall = 'error';
    else if (c.state === 'warn' && overall !== 'error') overall = 'warn';
    if (checks.length >= MAX_CHECKS) break;
  }
  return { checks, overall };
}

async function readMemAvailableRatio() {
  // Linux 는 MemAvailable(캐시 제외)이 정확하다. os.freemem() 은 캐시를 "사용 중"으로 세서 과장된다.
  try {
    const text = await fsp.readFile('/proc/meminfo', 'utf8');
    const total = /^MemTotal:\s+(\d+)/m.exec(text);
    const avail = /^MemAvailable:\s+(\d+)/m.exec(text);
    if (total && avail && Number(total[1]) > 0) return (Number(total[1]) - Number(avail[1])) / Number(total[1]);
  } catch {
    /* Linux 가 아니면 아래 대체값 */
  }
  const t = os.totalmem();
  return t > 0 ? (t - os.freemem()) / t : undefined;
}

/** 얻을 수 있는 지표만 모은다 (못 읽은 것은 필드를 뺀다). */
export async function collectMetrics() {
  const m = {};
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length || 1;
  const load = os.loadavg()[0];
  // Windows 는 loadavg 가 항상 0 이라 의미가 없으므로 뺀다.
  if (process.platform !== 'win32' && Number.isFinite(load)) m.cpu = round(load / Math.max(cores, 1));
  const ram = await readMemAvailableRatio();
  if (typeof ram === 'number' && Number.isFinite(ram)) m.ram = round(Math.min(Math.max(ram, 0), 1));
  try {
    if (typeof fsp.statfs !== 'function') throw new Error('statfs unavailable'); // Node 18.15 미만
    const root = parsePath(process.cwd()).root || '/';
    const s = await fsp.statfs(root);
    if (s.blocks > 0) m.disk = round(Math.min(Math.max(1 - s.bavail / s.blocks, 0), 1));
  } catch {
    /* fs.statfs 가 없는 Node 이거나 읽을 수 없으면 뺀다 */
  }
  m.uptimeSec = Math.floor(os.uptime());
  return m;
}
const round = (v) => Math.round(v * 1000) / 1000;

export class CentralAgent {
  /**
   * @param {object} o
   * @param {{load(): Promise<object|null>, save(c: object): Promise<void>}} o.store 설정 저장소
   * @param {() => Promise<{id: string, state: 'ok'|'warn'|'error', msg?: string}[]>} [o.collectChecks] manager 의 점검 결과
   * @param {() => Promise<number|undefined>} [o.getCertMinDays] 인증서 중 가장 짧은 남은 일수. 주면 `cert` 점검 항목도 자동으로 만든다 (manager 가 `cert` 항목을 직접 주면 그것을 쓴다)
   * @param {number} [o.certWarnDays] 이 일수 이하면 warn (기본 14)
   * @param {number} [o.certErrorDays] 이 일수 이하면 error (기본 5)
   * @param {{manager?: string}} [o.versions]
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {boolean} [o.allowHttp] 로컬 시험에서만 true (기본은 HTTPS 만)
   * @param {typeof fetch} [o.fetch] 시험용
   * @param {() => number} [o.now] 시험용
   */
  constructor(o) {
    this.store = o.store;
    this.collectChecks = o.collectChecks ?? (async () => []);
    this.getCertMinDays = o.getCertMinDays ?? (async () => undefined);
    this.certThresholds = { warnDays: o.certWarnDays ?? 14, errorDays: o.certErrorDays ?? 5 };
    this.versions = o.versions ?? {};
    this.log = o.log ?? (() => {});
    this.allowHttp = o.allowHttp === true;
    this.fetch = o.fetch ?? globalThis.fetch;
    this.now = o.now ?? (() => Date.now());
    this.timer = null;
    this.running = false;
    this.wanted = false; // start() 가 불렸는지 (설정이 없어 아직 못 돌고 있어도)
    this.sending = null;
    /** 마지막 전송 결과 (manager 설정 화면의 "마지막 전송 시각 / 결과"용) */
    this.last = null;
  }

  #checkUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new AgentError('invalid_config', 'invalid server url');
    }
    if (u.protocol !== 'https:' && !(this.allowHttp && u.protocol === 'http:')) {
      throw new AgentError('invalid_config', 'server url must be https');
    }
    return u.origin;
  }

  async isEnrolled() {
    return isConfigured(await this.store.load());
  }

  /**
   * 등록 코드로 siteSecret 을 받아 저장하고 첫 보고를 보낸다. 코드는 1회용이므로 실패해도 같은 코드를 다시 쓰지 말고
   * 응답을 못 받았다면 관리자에게 새 코드를 받는다. 잘못된 코드·만료·사용됨은 `invalid_code` 하나로 온다.
   */
  async enroll(code) {
    const parsed = parseEnrollCode(code);
    if (!parsed) throw new AgentError('invalid_code', 'malformed registration code');
    const origin = this.#checkUrl(parsed.serverUrl);
    let res;
    try {
      res = await this.fetch(`${origin}/v1/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: String(code).trim() }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AgentError('network', 'cannot reach the central server');
    }
    if (res.status === 401) throw new AgentError('invalid_code', 'invalid, expired or already used code', 401);
    if (res.status === 429) throw new AgentError('rate_limited', 'too many attempts, retry in 15 minutes', 429);
    if (!res.ok) throw new AgentError('server_error', `unexpected status ${res.status}`, res.status);
    const body = await res.json().catch(() => null);
    if (!body || body.siteId !== parsed.siteId || !SECRET_RE.test(body.siteSecret ?? '')) {
      throw new AgentError('invalid_response', 'unexpected enroll response');
    }
    await this.store.save({ serverUrl: origin, siteId: body.siteId, siteSecret: body.siteSecret });
    this.log('info', `enrolled as ${body.siteId}`);
    // start() 가 설정 없이 불렸다면 이제 정기 보고를 시작한다.
    if (this.wanted && !this.running) {
      this.running = true;
      this.#schedule(body.siteId);
    }
    return this.sendOnce();
  }

  /** payload 를 만든다 (전송하지 않는다). */
  async buildPayload(config) {
    let raw = [];
    try {
      raw = await this.collectChecks();
    } catch (e) {
      raw = [{ id: 'agent_checks', state: 'warn', msg: `checks failed: ${e && e.message ? e.message : 'error'}` }];
    }
    let certDays;
    try {
      const d = await this.getCertMinDays();
      if (Number.isInteger(d)) certDays = d;
    } catch {
      /* 인증서 점검을 못 해도 보고는 보낸다 */
    }
    raw = Array.isArray(raw) ? [...raw] : [];
    // 남은 일수가 있으면 cert 점검 항목을 더한다 (overall 에 반영되어 만료 임박이 알림으로 간다).
    if (certDays !== undefined && !raw.some((c) => c && c.id === 'cert')) raw.push(certCheck(certDays, this.certThresholds));
    const { checks, overall } = normalizeChecks(raw);
    const payload = {
      schema: 1,
      siteId: config.siteId,
      seq: Math.floor(this.now() / 1000), // epoch 초: 재시작·초기화에도 중복이 아닌 값이 된다
      sentAt: new Date(this.now()).toISOString(),
      version: { ...(this.versions.manager ? { manager: clean(this.versions.manager, 40) } : {}), agent: AGENT_VERSION },
      overall,
      checks,
      metrics: await collectMetrics(),
    };
    if (certDays !== undefined) payload.cert = { minDaysLeft: certDays };
    return payload;
  }

  /** 한 번 보낸다 (재시도 없음). 결과 `{ ok, http, retryable, result }`. 설정 화면의 "지금 보내기"와 등록 직후 점검에 쓴다. */
  async sendOnce(payload) {
    const config = await this.store.load();
    if (!isConfigured(config)) throw new AgentError('not_configured', 'not enrolled: nothing is sent');
    const origin = this.#checkUrl(config.serverUrl);
    const body = Buffer.from(JSON.stringify(payload ?? (await this.buildPayload(config))), 'utf8');
    const timestamp = String(Math.floor(this.now() / 1000));
    let outcome;
    try {
      const res = await this.fetch(`${origin}/v1/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Site-Id': config.siteId,
          'X-Timestamp': timestamp,
          'X-Signature': sign(config.siteSecret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const http = res.status;
      if (res.ok) outcome = { ok: true, http, retryable: false, result: 'ok' };
      else if (http === 429 || http >= 500) outcome = { ok: false, http, retryable: true, result: 'throttled_or_server_error' };
      else outcome = { ok: false, http, retryable: false, result: 'rejected' }; // 400/401: 설정(키·현장)을 고쳐야 한다
    } catch {
      outcome = { ok: false, http: 0, retryable: true, result: 'network' };
    }
    this.last = { at: new Date(this.now()).toISOString(), ...outcome };
    this.log(outcome.ok ? 'info' : 'warn', `report ${outcome.ok ? 'sent' : 'failed'} (http ${outcome.http}, ${outcome.result})`);
    return outcome;
  }

  /** 정기 보고 한 회: 같은 본문(같은 seq)을 새 타임스탬프·서명으로 재시도한다. 거절(400/401)이면 바로 멈춘다. */
  async sendWithRetry(sleep = (ms) => new Promise((r) => setTimeout(r, ms)), shouldStop = () => !this.running) {
    const config = await this.store.load();
    if (!isConfigured(config)) throw new AgentError('not_configured', 'not enrolled: nothing is sent');
    const payload = await this.buildPayload(config);
    let outcome;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      outcome = await this.sendOnce(payload);
      if (outcome.ok || !outcome.retryable || attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
      if (shouldStop()) break;
    }
    return outcome;
  }

  /**
   * 시작: 바로 한 번 보내고(배경) 이후 매시간. **관리자가 등록하지 않았다면(설정이 비어 있다면) 아무것도 보내지 않고 조용히 기다린다.**
   * 서버 주소는 등록 코드로만 들어오며 코드에 기본값이 없다. 나중에 `enroll()` 이 성공하면 그때부터 정기 보고를 시작한다.
   */
  async start() {
    if (this.running) return;
    this.wanted = true;
    const config = await this.store.load();
    if (!isConfigured(config)) {
      this.log('info', 'central agent is not configured: nothing is sent until an administrator registers this site');
      return;
    }
    this.running = true;
    this.#schedule(config.siteId);
    // 첫 보고는 배경에서 보낸다 (재시도가 최대 15분 걸릴 수 있어 manager 시작을 막지 않는다). 끝나기를 보려면 `agent.sending` 을 기다린다.
    this.sending = this.sendWithRetry().catch((e) => this.log('error', `report error: ${e.message}`));
  }

  #schedule(siteId) {
    if (!this.running) return;
    const delay = Math.max(1000, nextReportAt(siteId, this.now()) - this.now());
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      this.sending = this.sendWithRetry().catch((e) => this.log('error', `report error: ${e.message}`));
      await this.sending;
      this.#schedule(siteId);
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.wanted = false;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
