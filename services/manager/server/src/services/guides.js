const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * 설치 가이드 PDF — 로그인한 사람만 내려받는다.
 *
 * 소개 페이지(intro)는 공개 경로라 설치 방법을 싣지 않는다. 설치 가이드는
 * 이 장비를 구성할 사람에게만 주는 것이어서, 파일을 `docs/downloads/` 에 두고
 * manager 의 세션 뒤에서만 내보낸다.
 *
 * 안전장치는 docs.js 와 같은 방식이다 — **클라이언트가 보낸 이름을 파일시스템에
 * 넘기지 않는다.** 디렉터리를 읽어 만든 목록에 정확히 있는 이름만 경로로
 * 바꾸므로 상위 디렉터리 접근이 불가능하다. 목록에 오르는 것은 `*.pdf` 뿐이다.
 */
const GUIDES_DIR = process.env.MANAGER_GUIDES_DIR
  ? path.resolve(process.env.MANAGER_GUIDES_DIR)
  : path.join(config.repoRoot, 'docs', 'downloads');

const NAME_RE = /^[A-Za-z0-9._-]+\.pdf$/;

// 알려진 파일의 표시 이름. 없는 PDF 도 목록에서 빠지지는 않는다(파일 이름으로 나온다).
const KNOWN = {
  'WebServices-install-guide-ko.pdf': { title: '설치 가이드 — 한국어', lang: 'ko', order: 0 },
  'WebServices-install-guide-en.pdf': { title: 'Install Guide — English', lang: 'en', order: 1 },
};

async function list() {
  let names;
  try {
    names = await fs.promises.readdir(GUIDES_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  for (const name of names.filter((n) => NAME_RE.test(n))) {
    const st = await fs.promises.stat(path.join(GUIDES_DIR, name));
    if (!st.isFile()) continue;
    const known = KNOWN[name];
    items.push({
      name,
      title: known?.title || name,
      lang: known?.lang || null,
      size: st.size,
      updatedAt: st.mtime.toISOString(),
      order: known?.order ?? 100,
    });
  }
  return items.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(({ order: _o, ...rest }) => rest);
}

/** 목록에 정확히 있는 이름이면 절대 경로를, 아니면 null 을 준다. */
async function resolve(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const items = await list();
  return items.some((i) => i.name === name) ? path.join(GUIDES_DIR, name) : null;
}

module.exports = { list, resolve, GUIDES_DIR };
