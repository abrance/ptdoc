import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRatio, sourceHeadingRatios } from './scroll-sync.ts';

test('源码标题锚点比例按行号给出，跳过围栏代码块内的 #', () => {
  const md = ['# A', 'x', '```', '# 不是标题', '```', '## B', 'y'].join('\n');
  // 7 行：# A 在第 0 行 → 0；## B 在第 5 行 → 5/6
  assert.deepEqual(sourceHeadingRatios(md), [0, 5 / 6]);
});

test('没有标题时返回空数组（调用方退化为整体比例）', () => {
  assert.deepEqual(sourceHeadingRatios('正文\n~~~\n# fenced\n~~~'), []);
});

test('分段线性映射：锚点处对齐，段内插值', () => {
  const from = [0, 0.5, 1];
  const to = [0, 0.2, 1];
  assert.equal(mapRatio(0, from, to), 0);
  assert.equal(mapRatio(0.5, from, to), 0.2);
  assert.equal(mapRatio(1, from, to), 1);
  assert.equal(mapRatio(0.25, from, to), 0.1); // 第一段中点
  assert.ok(Math.abs(mapRatio(0.75, from, to) - 0.6) < 1e-9); // 第二段中点
});

test('锚点数量不一致时不猜，退化为整体比例并夹到 [0,1]', () => {
  assert.equal(mapRatio(0.3, [0, 0.5], [0, 0.4, 1]), 0.3);
  assert.equal(mapRatio(-1, [0, 1], [0, 1]), 0);
  assert.equal(mapRatio(2, [0, 1], [0, 1]), 1);
});

test('锚点相同时不产生除零，映射落在该锚点值上', () => {
  assert.equal(mapRatio(0.4, [0.5, 0.5], [0.3, 0.3]), 0.3);
});
