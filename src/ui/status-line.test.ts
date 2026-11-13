import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paintStatus } from './status-line.ts';

// P0-1 的核心验收：同一句错误不能在屏幕上出现两次。

test('失败：状态栏只放终态标记，具体原因只在 toast 里出现一次', () => {
  const msg = '上传失败：HTTP 502';
  const p = paintStatus(msg, true);

  assert.equal(p.error, true);
  assert.equal(p.toast, msg, 'toast 负责说原因');
  assert.notEqual(p.text, msg, '状态栏不能复述同一句话');
  assert.equal(p.text, '操作失败');
});

test('普通状态：只写状态栏，不弹 toast', () => {
  const p = paintStatus('已保存', false);
  assert.equal(p.text, '已保存');
  assert.equal(p.error, false);
  assert.equal(p.toast, '');
});

test('清空状态：既不写文字也不弹 toast（error=false 时 msg 为空）', () => {
  const p = paintStatus('', false);
  assert.equal(p.text, '');
  assert.equal(p.toast, '');
});

test('空消息 + isError：不弹空 toast、也不点亮错误样式', () => {
  // showToast('') 本来就什么都不做，但状态栏不能因此挂上红色 error 类。
  const p = paintStatus('', true);
  assert.equal(p.text, '');
  assert.equal(p.error, false);
  assert.equal(p.toast, '');
});
