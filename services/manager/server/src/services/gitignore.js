const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger');

/**
 * 서비스 추가 마법사가 "이 저장소에 함께 커밋" 을 고른 서비스를 위해
 * `.gitignore` 의 예외 한 줄을 더한다.
 *
 * 저장소 뿌리의 `.gitignore` 는 `services/*` 를 통째로 무시하고
 * `!services/<이름>/` 로 예외를 하나씩 연다(services/manager 등). 새 서비스도
 * 같은 자리에 한 줄을 보태야 커밋 대상이 된다 — 안 하면 마법사가 만든 파일이
 * 전부 무시된 채로 남는다.
 *
 * **앵커를 못 찾으면 아무것도 쓰지 않는다.** `.gitignore` 구조가 예상과
 * 다르면(사람이 손으로 크게 고쳐 둔 경우 등) 추측으로 끼워 넣지 않고 호출한
 * 쪽에 알려 사람이 직접 하게 한다.
 */

const GITIGNORE_PATH = path.join(config.repoRoot, '.gitignore');
const BLOCK_START = 'services/*';
const EXCEPTION_RE = /^!services\/([^/]+)\/\s*$/;

function entryLine(name) {
  return `!services/${name}/`;
}

function hasEntry(name) {
  let text;
  try {
    text = fs.readFileSync(GITIGNORE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return text.split('\n').some((line) => line.trim() === entryLine(name));
}

/**
 * 예외가 열려 있는 서비스 폴더 이름 전부.
 *
 * 이 목록이 곧 **패키지에 포함된 서비스**다 — 저장소가 이력째 들고 다니는
 * 것(manager)만 여기 있고, 자기
 * 저장소를 가진 plug-in 은 없다. 대시보드가 서비스를 기본/추가로 나눌 때
 * 이 값을 쓴다 (services/registry.js). 따로 목록을 적어 두면 여기와 어긋날
 * 수 있어서, 이미 있는 이 선언을 그대로 읽는다.
 *
 * 파일이 없으면 빈 Set — 그러면 전부 plug-in 으로 보인다. 그 상태가 뭔가
 * 잘못됐다는 신호가 되는 편이, 추측으로 채우는 것보다 낫다.
 */
function listEntries() {
  let text;
  try {
    text = fs.readFileSync(GITIGNORE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }

  const names = new Set();
  for (const line of text.split('\n')) {
    const m = line.trim().match(EXCEPTION_RE);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * `services/*` 줄 바로 다음부터 이어지는 `!services/...` 줄 중 **마지막** 것의
 * 인덱스. 그 블록이 없으면 -1.
 */
function findAnchorIndex(lines) {
  const start = lines.findIndex((line) => line.trim() === BLOCK_START);
  if (start === -1) return -1;

  let last = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (EXCEPTION_RE.test(lines[i])) {
      last = i;
      continue;
    }
    // 예외 줄이 아닌 것을 만나면(빈 줄 포함) 블록이 끝난 것이다.
    break;
  }
  return last;
}

/**
 * `!services/<name>/` 을 예외 블록의 마지막 줄 뒤에 끼워 넣는다. 이미 있으면
 * 아무것도 하지 않는다(멱등).
 *
 * 반환: { ok: true, added: boolean } | { ok: false, reason }
 */
function addEntry(name) {
  if (hasEntry(name)) return { ok: true, added: false };

  let text;
  try {
    text = fs.readFileSync(GITIGNORE_PATH, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'gitignore_missing' };
  }

  // 끝에 개행이 있던 파일은 split 이 마지막에 빈 문자열을 하나 더 만들어
  // 두고, join 이 그것을 그대로 되살리므로 개행 유무를 따로 챙길 필요가 없다.
  const lines = text.split('\n');
  const anchor = findAnchorIndex(lines);
  if (anchor === -1) {
    log.warn(`gitignore: services/* 예외 블록을 찾지 못했습니다 — !services/${name}/ 를 추가하지 못했습니다`);
    return { ok: false, reason: 'anchor_not_found' };
  }

  lines.splice(anchor + 1, 0, entryLine(name));
  const next = lines.join('\n');

  const tmp = `${GITIGNORE_PATH}.tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, GITIGNORE_PATH);

  return { ok: true, added: true };
}

/**
 * `!services/<name>/` 한 줄을 뺀다 (서비스를 지울 때). 없으면 아무것도 하지 않는다(멱등).
 * 반환: { ok: true, removed: boolean } | { ok: false, reason }
 */
function removeEntry(name) {
  if (!hasEntry(name)) return { ok: true, removed: false };

  let text;
  try {
    text = fs.readFileSync(GITIGNORE_PATH, 'utf8');
  } catch {
    return { ok: false, reason: 'gitignore_missing' };
  }

  const line = entryLine(name);
  const lines = text.split('\n').filter((l) => l.trim() !== line);
  const tmp = `${GITIGNORE_PATH}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, GITIGNORE_PATH);
  return { ok: true, removed: true };
}

module.exports = { GITIGNORE_PATH, hasEntry, listEntries, addEntry, removeEntry };
