#!/usr/bin/env node
//
// web/ 의 의존성이 실제로 깔려 있는지 빌드 **전에** 본다.
//
// ── 왜 필요한가 ──────────────────────────────────────────────
// 이 디렉터리의 package.json 은 부르기만 하는 래퍼라 node_modules 를 갖지
// 않는다 (docs/guide/install.md '6. `bootstrap.sh --apply` — manager 세우기' 참고). 그래서 `npm run build` 는 web/ 의
// 의존성이 없어도 그냥 vite 를 부르고, 사람은
//
//     Failed to resolve import "react-markdown" from "src/pages/Docs.jsx"
//
// 같은 vite 의 해석 오류를 본다. 무엇이 **깨졌는지**로 읽히지만 실제 원인은
// 무엇을 **안 돌렸는지**다 — setup 을 건너뛰고 build 만 부른 것이다.
//
// 2026-09-07 정본 통합에서 web/package.json 에 의존성 셋이 새로 들어왔고
// (react-markdown · remark-gfm · @tailwindcss/typography), 통합 전에 깔아 둔
// node_modules 를 그대로 둔 채 build 를 돌린 사람이 정확히 그 오류를 만났다.
// 그때 필요한 것은 "무엇이 없으니 setup 을 먼저 돌려라" 한 줄이다.
//
// ── 무엇을 하지 않는가 ──────────────────────────────────────
// 스스로 npm install 을 부르지 않는다. 이 저장소의 다른 곳과 같은 자세다 —
// 설치는 사람이 명령을 보고 돌린다 (install.sh 의 --check / --apply 갈림과
// 같다). 여기서는 알려 주기만 한다.
//
// 의존성을 갖지 않는다 — node 기본 모듈만 쓴다.
//

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, 'web');
const SERVER = path.join(__dirname, 'server');

function die(lines) {
    console.error('');
    for (const l of lines) console.error(l);
    console.error('');
    process.exit(1);
}

const webPkgPath = path.join(WEB, 'package.json');
if (!fs.existsSync(webPkgPath)) {
    die([`web/package.json 이 없습니다 (${webPkgPath}).`,
         '저장소가 온전한지 확인하세요 — git status.']);
}

const webPkg = JSON.parse(fs.readFileSync(webPkgPath, 'utf8'));
const wanted = Object.keys({ ...webPkg.dependencies, ...webPkg.devDependencies });

// 패키지 이름은 '@scope/name' 형태도 그대로 디렉터리 경로가 된다.
const installed = (name) =>
    fs.existsSync(path.join(WEB, 'node_modules', name, 'package.json'));

const setupHint = [
    '    cd services/manager && npm run setup',
    '',
    'setup 은 server 의존성 → web 의존성 → web 빌드를 차례로 합니다.',
    'build 는 이미 설치된 상태에서 화면만 다시 만드는 명령입니다.',
];

if (!fs.existsSync(path.join(WEB, 'node_modules'))) {
    die(['web/node_modules 가 없습니다 — 의존성을 아직 설치하지 않았습니다.',
         '', ...setupHint]);
}

const missing = wanted.filter((n) => !installed(n));
if (missing.length > 0) {
    die([`web/ 의존성 ${missing.length}개가 설치돼 있지 않습니다.`,
         '',
         `    없는 것: ${missing.join(', ')}`,
         '',
         'web/package.json 이 바뀐 뒤(예: git pull) 설치를 다시 하지 않으면',
         '이렇게 됩니다. vite 의 import 해석 오류로 보이지만 원인은 이쪽입니다.',
         '',
         ...setupHint]);
}

// server 쪽은 빌드를 막지 않는다 — 빌드 산출물은 server/public/ 로 가지만
// 그것을 만드는 데 server/node_modules 가 필요하지는 않다. 다만 이대로면
// 대시보드가 뜨지 않으므로 한 줄 알려는 준다. setup 이 둘 다 해결한다.
if (!fs.existsSync(path.join(SERVER, 'node_modules'))) {
    console.warn('');
    console.warn('알림: server/node_modules 가 없습니다. 빌드는 되지만 대시보드는 뜨지 않습니다.');
    console.warn('      npm run setup 이 둘 다 설치합니다.');
    console.warn('');
}
