'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 시험용 임시 디렉터리 — guides.js 가 불러올 때 읽는다.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-guides-'));
process.env.MANAGER_GUIDES_DIR = dir;
fs.writeFileSync(path.join(dir, 'WebServices-install-guide-en.pdf'), '%PDF-en');
fs.writeFileSync(path.join(dir, 'WebServices-install-guide-ko.pdf'), '%PDF-ko');
fs.writeFileSync(path.join(dir, 'extra.pdf'), '%PDF-x');
fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a pdf');
fs.mkdirSync(path.join(dir, 'sub.pdf'));
fs.writeFileSync(path.join(path.dirname(dir), 'outside.pdf'), 'secret');
const guides = require('../src/services/guides');

test('list: PDF 만, 알려진 것은 한국어가 먼저', async () => {
  const names = (await guides.list()).map((f) => f.name);
  assert.deepEqual(names, ['WebServices-install-guide-ko.pdf', 'WebServices-install-guide-en.pdf', 'extra.pdf']);
  const ko = (await guides.list())[0];
  assert.equal(ko.lang, 'ko');
  assert.equal(ko.size, 7);
});

test('resolve: 목록에 있는 이름만 경로가 된다', async () => {
  assert.equal(await guides.resolve('extra.pdf'), path.join(dir, 'extra.pdf'));
});

test('resolve: 상위 경로·없는 파일·PDF 아닌 것·디렉터리는 null', async () => {
  for (const bad of ['../outside.pdf', '..%2Foutside.pdf', '/etc/passwd', 'notes.txt', 'sub.pdf', 'nope.pdf', '', undefined, 42, 'a/b.pdf', 'x.pdf\0']) {
    assert.equal(await guides.resolve(bad), null, String(bad));
  }
});

test('디렉터리가 없으면 빈 목록', async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(await guides.list(), []);
});
