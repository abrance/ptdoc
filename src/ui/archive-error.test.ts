import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveErrorText } from './archive.ts';

// P0-1 的验收点：失败必须告诉用户断在哪一步，并且文案要能直接放进「重试」提示里。

test('三段失败点各自给出可读的中文阶段名', () => {
  assert.equal(
    archiveErrorText({ error: 'svg 渲染异常', step: 'render' }),
    'mermaid 图表渲染 阶段：svg 渲染异常',
  );
  assert.equal(
    archiveErrorText({ error: '403 Forbidden', step: 'upload' }),
    '对象存储上传 阶段：403 Forbidden',
  );
  assert.equal(
    archiveErrorText({ error: 'disk I/O error', step: 'db' }),
    '归档记录写库 阶段：disk I/O error',
  );
});

test('没有 step 时只报错误本身，不编造阶段', () => {
  assert.equal(archiveErrorText({ error: '文档不存在' }), '文档不存在');
});

test('既没有 error 也没有 step 时退回 HTTP 状态码，绝不返回空白', () => {
  // 空白 toast 等于「失败了但没说原因」，比报错更糟。
  assert.equal(archiveErrorText({}, 502), 'HTTP 502');
});

test('未知 step 原样透出，不吞掉服务端新增的阶段', () => {
  assert.equal(archiveErrorText({ error: 'x', step: 'cdn' }), 'cdn 阶段：x');
});
