#!/usr/bin/env node
//
// web/ 소스가 빌드 결과(server/public/)보다 새로운지 본다.
//
// check-restart.js 는 server/src/ 만 본다. 화면 소스(web/)를 고치고 빌드를
// 안 했거나 git pull 로 화면이 바뀐 경우는 아무도 알리지 못해, 설치본이 옛
// 화면을 계속 내보냈다. 그 빈틈을 메운다.
//
// 알림이지 점검 실패가 아니다 — 말할 것이 있으면 출력하고, 없으면 조용하다.
// 종료 코드는 늘 0. 빌드 결과가 아직 없으면(개발 장비) 아무 말도 하지 않는다.
// 의존성 없음 — node 기본 모듈만 쓴다.
//

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, 'web');
const OUT = path.join(__dirname, 'server', 'public');
const SKIP = new Set(['node_modules', 'dist']);

function newest(p) {
    let st;
    try { st = fs.statSync(p); } catch { return null; }
    if (!st.isDirectory()) return { path: p, mtime: st.mtime };
    let best = null;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const n = newest(path.join(p, e.name));
        if (n && (!best || n.mtime > best.mtime)) best = n;
    }
    return best;
}

const built = newest(OUT);
if (!built || !fs.existsSync(WEB)) process.exit(0);

// 빌드에 영향을 주는 입력: 소스·index.html·설정·의존성 선언. (node_modules 제외)
let src = null;
for (const e of fs.readdirSync(WEB, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const n = newest(path.join(WEB, e.name));
    if (n && (!src || n.mtime > src.mtime)) src = n;
}
if (!src || src.mtime <= built.mtime) process.exit(0);

const t = (d) => d.toLocaleString('ko-KR', { hour12: false });
console.log('');
console.log('알림: web/ 소스가 빌드 결과(server/public/)보다 새롭습니다.');
console.log('');
console.log(`      빌드 결과  ${t(built.mtime)}`);
console.log(`      ${path.relative(__dirname, src.path)}  ${t(src.mtime)}`);
console.log('');
console.log('      화면 수정이 아직 반영되지 않았습니다.');
console.log('');
console.log('          npm run build');
console.log('');
