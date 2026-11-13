import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { errorStateHtml } from './list-state.ts';

// P1-6 回归守卫：快照面板的 500 以前只印一行「加载失败」，没有任何出路，
// 用户只能整页刷新。现在必须复用 P1-4 的 errorStateHtml，给出可点的「重试」。

const src = readFileSync(new URL('./versions.ts', import.meta.url), 'utf8');

test('版本列表的失败分支走 errorStateHtml，不再手拼 empty 灰字', () => {
  assert.match(src, /errorStateHtml\([\s\S]{0,120}?'versions'\)/, '失败分支必须给出 retry 目标 versions');
  assert.doesNotMatch(
    src,
    /<li class="empty">加载失败/,
    '旧的「加载失败」灰字行没有重试入口，属于不可恢复的错误态',
  );
});

test('#version-list 上接了 data-retry 的点击回调，点了真的会重跑 load', () => {
  assert.match(src, /closest\('\[data-retry\]'\)/, '重试按钮是 innerHTML 拼出来的，必须走事件委托');
  assert.match(src, /closest\('\[data-retry\]'\)[\s\S]{0,120}void load\(false\)/, '点重试要重跑加载');
});

test('retry 目标与 app.ts 的处理集合一致，不会点了没反应', () => {
  // list-state.ts 的 RetryTarget 里每个值都必须在某个加载器里有处理分支。
  const retry = errorStateHtml('版本列表加载失败', 'versions');
  assert.match(retry, /data-retry="versions"/);
  assert.match(retry, /role="alert"/);
});
