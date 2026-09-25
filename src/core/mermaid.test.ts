import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMermaidToSvg, hashMermaid } from './mermaid.ts';

const FLOW = 'flowchart TD\n  A[开始] --> B[结束]';

test('渲染结果是 SVG，并注入了 ptdoc 线条/分组覆盖样式', async () => {
  const svg = await renderMermaidToSvg(FLOW);
  assert.match(svg, /^<svg/);
  // LINE_STYLES.solid / GROUP_STYLES 由 applySvgStyleOverrides 注入，是「走没走我们的胶水」的标志
  assert.ok(svg.includes('stroke-width: 1.5'), '缺少线条覆盖样式');
  assert.ok(svg.includes('--_group-fill'), '缺少 subgraph 配色覆盖');
});

test('同一份源码返回完全一致的 SVG（进程内缓存命中）', async () => {
  const a = await renderMermaidToSvg(FLOW);
  const b = await renderMermaidToSvg(FLOW);
  assert.equal(a, b);
});

test('不同源码渲染出不同结果', async () => {
  const a = await renderMermaidToSvg(FLOW);
  const b = await renderMermaidToSvg('flowchart LR\n  X --> Y');
  assert.notEqual(a, b);
});

test('前后空白不影响缓存键（与渲染前 trim 的行为一致）', async () => {
  const a = await renderMermaidToSvg(FLOW);
  const b = await renderMermaidToSvg('\n' + FLOW + '\n');
  assert.equal(a, b);
});

test('hashMermaid 稳定且区分大小写', () => {
  assert.equal(hashMermaid(FLOW), hashMermaid(FLOW));
  assert.notEqual(hashMermaid('graph TD'), hashMermaid('graph Td'));
});
