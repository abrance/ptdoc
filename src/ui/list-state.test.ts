import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStateHtml, errorStateHtml } from './list-state.ts';

// P1-4 的验收点：空态与错态必须能区分开，错态要能点重试。

test('空态与错态用不同的类名，用户能一眼分清', () => {
  const empty = emptyStateHtml('暂无记录');
  const error = errorStateHtml('最近打开加载失败', 'history');

  assert.match(empty, /class="empty"/);
  assert.doesNotMatch(empty, /load-error/, '空态不能带错误类');
  assert.match(error, /class="load-error"/);
  assert.doesNotMatch(error, /class="empty"/, '错态不能复用空态的类');
});

test('错态带可点的重试按钮，并说明重跑哪个加载', () => {
  const error = errorStateHtml('会话列表加载失败', 'nav-convs');
  assert.match(error, /data-retry="nav-convs"/);
  assert.match(error, /<button[^>]*type="button"[^>]*>重试<\/button>/);
  // role=alert：读屏会把「加载失败」念出来，不必等用户自己扫到。
  assert.match(error, /role="alert"/);
});

test('空态没有任何可点元素', () => {
  assert.doesNotMatch(emptyStateHtml('没有匹配的文档'), /<button/);
});

test('文案来自接口时一律转义，不会被当成标签执行', () => {
  const html = errorStateHtml('<img src=x onerror=alert(1)>', 'history');
  assert.doesNotMatch(html, /<img/, '不可信文本必须转义');
  assert.match(html, /&lt;img/);
});
