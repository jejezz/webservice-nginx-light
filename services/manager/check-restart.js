#!/usr/bin/env node
//
// 빌드가 끝난 뒤, **돌고 있는 프로세스가 옛 서버 코드인지** 본다.
//
// ── 왜 필요한가 ──────────────────────────────────────────────
// `npm run build` 는 web/ 을 server/public/ 로 굽는다. 화면만 바뀐 흔한
// 경우에는 그것으로 끝이다 — express 가 정적 파일을 그때그때 읽으므로 pm2 를
// 건드릴 필요가 없다.
//
// 그런데 server/src/ 까지 같이 바뀐 경우(예: git pull 로 새 API 라우트가
// 들어온 때)에는 절반만 반영된다. 화면은 새 API 를 부르는데 돌고 있는 서버는
// 그 라우트를 모른다 → 404 → **빈 화면**. 무엇이 잘못됐는지 화면에는 아무
// 단서가 없다.
//
// 2026-09-07 정본 통합에서 실제로 그랬다. routes/api.js 에 /api/docs 와
// /api/port-map 이 들어왔는데 pm2 를 재시작하지 않아 /manager/docs 와
// /manager/port-map 이 아무것도 보여 주지 않았다.
//
// ── 판정 ────────────────────────────────────────────────────
// pm2 가 알려 주는 프로세스 기동 시각과 server/src/ 의 가장 새로운 mtime 을
// 견준다. 소스가 더 새로우면 알린다. 조건이 맞을 때만 말하므로 화면만 고친
// 평범한 빌드에서는 조용하다.
//
// **빌드를 실패시키지 않는다.** 이것은 알림이지 점검이 아니다 — postbuild 가
// 0 이 아닌 값으로 끝나면 성공한 빌드가 실패로 보인다. pm2 가 없거나(개발
// 장비) 프로세스가 안 떠 있으면 아무 말도 하지 않고 끝낸다.
//
// 스스로 pm2 restart 를 부르지는 않는다 — 돌리는 것은 사람이 한다.
//
// 의존성을 갖지 않는다 — node 기본 모듈만 쓴다.
//

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, 'server', 'src');

// pm2 앱 이름은 선언에서 읽는다 (pm2-conf/app.ini). 못 읽으면 디렉터리 이름.
function appName() {
    try {
        const ini = fs.readFileSync(path.join(__dirname, 'pm2-conf', 'app.ini'), 'utf8');
        const m = ini.match(/^\s*name\s*=\s*(\S+)\s*$/m);
        if (m) return m[1];
    } catch { /* 선언이 없으면 아래로 */ }
    return path.basename(__dirname);
}

// server/src/ 아래에서 가장 최근에 바뀐 파일.
function newestSource(dir) {
    let newest = null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const inner = newestSource(p);
            if (inner && (!newest || inner.mtime > newest.mtime)) newest = inner;
        } else if (e.isFile()) {
            const { mtime } = fs.statSync(p);
            if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
        }
    }
    return newest;
}

// pm2 jlist 는 JSON 을 내지만 앞뒤에 다른 줄이 붙는 판이 있다. 대괄호 범위만 뗀다.
function pm2Process(name) {
    let out;
    try {
        out = execFileSync('pm2', ['jlist'], {
            encoding: 'utf8', timeout: 15000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return null; // pm2 가 없거나 대답하지 않는다 — 할 말이 없다.
    }
    const s = out.indexOf('['), e = out.lastIndexOf(']');
    if (s < 0 || e < s) return null;
    try {
        return JSON.parse(out.slice(s, e + 1))
            .find((p) => p.name === name && p.pm2_env && p.pm2_env.status === 'online') || null;
    } catch {
        return null;
    }
}

const hhmm = (d) => d.toLocaleString('ko-KR', { hour12: false });

if (!fs.existsSync(SRC)) process.exit(0);

const name = appName();
const proc = pm2Process(name);
if (!proc) process.exit(0);

const started = new Date(proc.pm2_env.pm_uptime);
const newest = newestSource(SRC);
if (!newest || newest.mtime <= started) process.exit(0);

const rel = path.relative(__dirname, newest.path);
console.log('');
console.log(`알림: server/src/ 가 돌고 있는 '${name}' 프로세스보다 새롭습니다.`);
console.log('');
console.log(`      프로세스 기동  ${hhmm(started)}`);
console.log(`      ${rel}  ${hhmm(newest.mtime)}`);
console.log('');
console.log('      화면은 새 서버 코드를 기대하는데 돌고 있는 것은 옛 코드입니다.');
console.log('      API 가 404 를 주고 화면이 비어 보일 수 있습니다.');
console.log('');
console.log(`          npm run restart        (= pm2 restart ${name})`);
console.log('');
