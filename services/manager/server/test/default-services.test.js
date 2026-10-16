'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gitignore = require('../src/services/gitignore');
const { PROTECTED } = require('../src/services/remove');

// 기본(Default) 서비스의 정의는 `.gitignore` 의 `!services/<이름>/` 예외다. 서비스 제거·검사 화면이
// 지키는 PROTECTED 목록이 그것과 어긋나면 기본 서비스를 plug-in 으로 잘못 다루게 된다 —
// 새 기본 서비스를 더하고 PROTECTED 를 빠뜨리면 여기서 걸린다.
test('PROTECTED 는 .gitignore 의 기본 서비스 예외와 같다', () => {
  const defaults = [...gitignore.listEntries()].sort();
  assert.ok(defaults.length > 0, '.gitignore 에서 기본 서비스를 읽지 못했습니다');
  assert.deepEqual([...PROTECTED].sort(), defaults);
});

test('light 판의 기본 서비스는 manager 하나다', () => {
  assert.deepEqual([...gitignore.listEntries()], ['manager']);
  assert.ok(PROTECTED.has('manager'));
});
