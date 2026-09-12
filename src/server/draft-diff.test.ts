import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from './draft-diff.ts';

test('相同文本只有 equal hunk', () => {
  const hunks = lineDiff('a\nb', 'a\nb');
  assert.deepEqual(hunks, [{ type: 'equal', lines: ['a', 'b'] }]);
});

test('新增与删除行', () => {
  const hunks = lineDiff('keep\nold', 'keep\nnew');
  assert.equal(hunks[0].type, 'equal');
  assert.deepEqual(hunks[0].lines, ['keep']);
  const types = hunks.slice(1).map((h) => h.type);
  assert.ok(types.includes('del'));
  assert.ok(types.includes('add'));
});
