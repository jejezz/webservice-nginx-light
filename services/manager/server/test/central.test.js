'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 등록 정보 파일은 시험용 임시 위치에 둔다 (central.js 가 불러올 때 읽는다).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-central-'));
process.env.MANAGER_CENTRAL_STORE = path.join(dir, 'central.json');
const central = require('../src/services/central');

const realFetch = globalThis.fetch;
const calls = [];
const SECRET = 'b'.repeat(64);
let enrollSiteId = 'site-0001'; // 중앙 서버 흉내가 등록 응답에 돌려줄 siteId
// 중앙 서버 흉내. 어디로 보냈는지만 기록한다 (인증서 점검 등 다른 fetch 는 제외).
globalThis.fetch = async (url) => {
  if (String(url).includes('/v1/')) calls.push(String(url));
  const body = String(url).endsWith('/v1/enroll') ? { siteId: enrollSiteId, siteSecret: SECRET } : { status: 'ok' };
  return { ok: true, status: 200, json: async () => body };
};

const codeFor = (host, scheme = 'https') =>
  `wsc1.site-0001.${'0'.repeat(48)}.${Buffer.from(`${scheme}://${host}`).toString('base64url')}`;
const errOf = (p) => p.then(() => null, (e) => e);

test.after(() => {
  central.stop();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('등록 전: 미등록이고 시작해도 지금 보내기도 아무것도 전송하지 않는다', async () => {
  await central.startIfEnrolled();
  const s = await central.status();
  assert.equal(s.enrolled, false);
  assert.equal(s.running, false);
  assert.equal(s.site, null);
  const e = await errOf(central.sendNow());
  assert.equal(e?.code, 'not_configured');
  assert.equal(await central.isAgentError(e), true);
  assert.equal(calls.length, 0);
});

test('잘못된 등록 코드는 invalid_code, HTTPS 가 아닌 주소는 invalid_config — 둘 다 전송 없음', async () => {
  assert.equal((await errOf(central.enroll('not-a-code')))?.code, 'invalid_code');
  assert.equal((await errOf(central.enroll(codeFor('central.example', 'http'))))?.code, 'invalid_config');
  assert.equal(calls.length, 0);
  assert.equal((await central.status()).enrolled, false);
});

test('응답의 siteId 가 코드의 siteId 와 다르면 거절하고 아무것도 저장하지 않는다', async () => {
  enrollSiteId = 'site-9999';
  const e = await errOf(central.enroll(codeFor('mine.example')));
  assert.equal(e?.code, 'invalid_response');
  assert.equal(fs.existsSync(process.env.MANAGER_CENTRAL_STORE), false);
  assert.equal((await central.status()).enrolled, false);
  enrollSiteId = 'site-0001';
  calls.length = 0;
});

test('등록: 코드 안의 주소로만 보내고, 응답·파일에서 비밀이 새지 않는다', async () => {
  const code = codeFor('mine.example');
  await central.enroll(code);
  assert.ok(calls.length >= 2); // 등록 + 첫 보고
  for (const u of calls) assert.ok(u.startsWith('https://mine.example/v1/'), u);

  const s = await central.status();
  assert.equal(s.enrolled, true);
  assert.deepEqual(s.site, { siteId: 'site-0001' });
  const shown = JSON.stringify(s);
  assert.ok(!shown.includes(SECRET));
  assert.ok(!shown.includes(code));
  assert.ok(!shown.includes('mine.example'));

  const saved = JSON.parse(fs.readFileSync(process.env.MANAGER_CENTRAL_STORE, 'utf8'));
  assert.equal(saved.serverUrl, 'https://mine.example');
  assert.equal(fs.statSync(process.env.MANAGER_CENTRAL_STORE).mode & 0o777, 0o600);
});

test('다시 등록하면 새 코드의 주소로 덮어쓴다', async () => {
  calls.length = 0;
  await central.enroll(codeFor('other.example'));
  const saved = JSON.parse(fs.readFileSync(process.env.MANAGER_CENTRAL_STORE, 'utf8'));
  assert.equal(saved.serverUrl, 'https://other.example');
  assert.ok(calls.some((u) => u.startsWith('https://other.example/v1/enroll')));
});
