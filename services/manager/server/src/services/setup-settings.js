const os = require('os');
const path = require('path');
const config = require('../config');
const log = require('../logger');

// 스키마를 읽고 쓰고 검증하는 코드는 저장소 공용입니다 — 서비스 자신의
// 대시보드도 같은 것을 씁니다 (docs/guide/contracts.md '설정 규약').
const shared = require(path.join(config.repoRoot, 'lib', 'settings'));

/**
 * 구축 마법사의 **파라미터 입력**.
 *
 * 단계에 `settings` 가 붙어 있으면 그 서비스의 `settings-schema.json` 을 읽어
 * 폼을 그리고, 사람이 넣은 값을 그 서비스의 `settings.ini` 에 씁니다.
 *
 * ── 경계 ────────────────────────────────────────────────────────────────
 *
 *   1. **쓰는 파일은 단계 표가 정합니다.** 경로를 사람 입력에서 만들지 않고,
 *      저장소 밖으로 나가면 거부합니다.
 *   2. **값만 씁니다.** 설정 파일(.jcfg · kamailio-local.cfg)을 만지지 않고,
 *      서비스를 재기동하지도 않습니다. 반영은 사람이 `--apply` 로 합니다.
 *   3. 검증은 공용 구현이 하고, root 로 도는 적용 스크립트가 **한 번 더** 합니다.
 *
 * 마법사가 파일을 쓰는 곳은 여기와 사람의 확인 기록(setup-attest.js) 둘뿐입니다.
 */

function resolveDir(step) {
  const dir = path.resolve(config.repoRoot, step.settings.dir);
  const root = config.repoRoot.endsWith(path.sep) ? config.repoRoot : `${config.repoRoot}${path.sep}`;
  if (!dir.startsWith(root)) throw new Error(`settings dir escapes repo root: ${dir}`);
  return dir;
}

/**
 * 이 장비에서 알아낼 수 있는 값의 후보. 사람이 에디터로 주소를 찾아 적지 않게 한다.
 * **후보일 뿐이다** — 채우는 것도 저장하는 것도 사람이 누른다.
 *
 *   ipv4 형 LAN 주소 항목 → 이 장비의 loopback 이 아닌 IPv4 (인터페이스 이름과 함께)
 *   lan_iface            → IPv4 가 붙은 인터페이스 이름
 */
const LAN_ADDR_KEYS = new Set(['sip_listen_addr', 'sip_local_ip']);

function localCandidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address });
    }
  }
  return out;
}

function suggestionsFor(fields) {
  const cands = localCandidates();
  const result = {};
  for (const f of fields) {
    if (LAN_ADDR_KEYS.has(f.key)) {
      result[f.key] = cands.map((c) => ({ value: c.address, note: c.iface }));
    } else if (f.key === 'lan_iface') {
      result[f.key] = [...new Set(cands.map((c) => c.iface))].map((n) => ({ value: n, note: '' }));
    }
  }
  return result;
}

/** 꼭 채워야 하는데 비어 있는 항목의 키. 기본값이 있으면 비어 있는 것이 아니다. */
function missingRequired(state) {
  return state.fields
    .filter((f) => !f.optional && !String(state.values[f.key] ?? '').trim())
    .map((f) => f.key);
}

/** 화면이 쓸 상태. 스키마를 읽지 못하면 null 을 돌려주고 폼을 그리지 않는다. */
function read(step) {
  if (!step.settings) return null;

  try {
    const state = shared.state(resolveDir(step));
    return {
      ...state,
      // 화면에는 저장소 기준 경로만 보여 준다.
      settingsPath: path.relative(config.repoRoot, state.settingsPath),
      appliedPath: path.relative(config.repoRoot, state.appliedPath),
      applyCwd: step.settings.dir,
      missing: missingRequired(state),
      suggestions: suggestionsFor(state.fields),
    };
  } catch (err) {
    log.warn(`setup settings ${step.id}: ${err.message}`);
    return null;
  }
}

/**
 * 값을 저장한다. 형식이 맞지 않으면 아무것도 쓰지 않고 어느 항목이 왜 틀렸는지
 * 돌려준다.
 */
function save(step, input) {
  if (!step.settings) throw new Error(`step has no settings: ${step.id}`);

  const dir = resolveDir(step);
  const result = shared.save(dir, input || {});
  if (!result.ok) return result;

  log.info(`setup settings saved: ${step.id} (${step.settings.dir}/settings.ini)`);
  return { ok: true, settings: read(step) };
}

/** 자동 실행 전에: 꼭 필요한 값이 비어 있으면 그 키들. 설정 폼이 없는 단계는 빈 배열. */
function missingFor(step) {
  if (!step.settings) return [];
  try {
    return missingRequired(shared.state(resolveDir(step)));
  } catch {
    return [];
  }
}

module.exports = { read, save, missingFor };
