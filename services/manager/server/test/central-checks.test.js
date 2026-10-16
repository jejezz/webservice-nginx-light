'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('../src/services/central-checks');

const deps = (over = {}) => ({
  nginxStatus: async () => ({ active: true, state: 'active' }),
  ...over,
});

const byId = (list) => Object.fromEntries(list.map((c) => [c.id, c]));

test('정상이면 약속된 id(nginx)가 ok', async () => {
  const r = byId(await collect(deps()));
  assert.deepEqual(Object.keys(r), ['nginx']);
  assert.equal(r.nginx.state, 'ok');
});

test('nginx 가 죽었으면 error + 상태 요약', async () => {
  const r = byId(await collect(deps({ nginxStatus: async () => ({ active: false, state: 'failed' }) })));
  assert.equal(r.nginx.state, 'error');
  assert.match(r.nginx.msg, /process not running \(failed\)/);
});

test('점검이 예외로 실패해도 항목은 남고 warn + 이유', async () => {
  const r = byId(await collect(deps({
    nginxStatus: async () => { throw new Error('boom'); },
  })));
  assert.equal(r.nginx.state, 'warn');
  assert.match(r.nginx.msg, /boom/);
});

test('msg 는 200자 이하이고 내부 주소를 싣지 않는다', async () => {
  const r = await collect(deps({ nginxStatus: async () => ({ active: false, state: 'x'.repeat(500) }) }));
  for (const c of r) {
    assert.ok((c.msg || '').length <= 200);
    assert.doesNotMatch(c.msg || '', /\d+\.\d+\.\d+\.\d+/);
  }
});
