import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyWorkspaceGate, type GatedEl } from './auth-chrome.ts';

// P0-2 / P2-9 回归守卫：登录态未知或未登录时，工作区必须既不绘制也不可 Tab。
// 这里的「开工/收工」是全站唯一的开关，别的分支不许绕过它。

function el(init?: Partial<GatedEl>): GatedEl {
  return { inert: false, hidden: false, ...init };
}

test('未登录：inert 与 hidden 一起上，缺一个都算漏', () => {
  const app = el();
  const skip = el();
  applyWorkspaceGate([app, skip], false);
  // inert 挡键盘与读屏；hidden 挡绘制（P2-9 的首屏闪一版）。
  assert.deepEqual(app, { inert: true, hidden: true });
  assert.deepEqual(skip, { inert: true, hidden: true }, '「跳到编辑器」指向被锁区域，也要一起关');
});

test('已登录：两个都摘掉，工作区恢复可交互', () => {
  const app = el({ inert: true, hidden: true });
  const skip = el({ inert: true, hidden: true });
  applyWorkspaceGate([app, skip], true);
  assert.deepEqual(app, { inert: false, hidden: false });
  assert.deepEqual(skip, { inert: false, hidden: false });
});

test('缺元素不炸：首帧 DOM 尚未解析完时按 id 取可能拿到 null', () => {
  assert.doesNotThrow(() => applyWorkspaceGate([null, undefined, el()], false));
});

test('index.html 的工作区静态就带 inert + hidden，首帧没机会漏出来', () => {
  // 守卫写在静态标记上，而不是等 JS 跑完：startGate 要等 /api/setup/status 往返，
  // 那段窗口内若标记是开放的，后台控件就已经能 Tab 了（P0-2 的原形）。
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const appTag = html.match(/<div class="app"[^>]*>/);
  assert.ok(appTag, 'index.html 里找不到 .app 容器');
  assert.match(appTag[0], /id="app"/, '登录回调要靠 id=app 打开它');
  assert.match(appTag[0], /\binert\b/, '.app 必须静态 inert：否则未登录也能 Tab 进后台控件');
  assert.match(appTag[0], /\bhidden\b/, '.app 必须静态 hidden：否则首屏会闪一版编辑器（P2-9）');

  const skip = html.match(/<a class="skip-link"[^>]*>/);
  assert.ok(skip, 'index.html 里找不到 skip-link');
  assert.match(skip[0], /\binert\b/, '跳转链接指向被锁的 #editor，必须跟着关');
  assert.match(skip[0], /\bhidden\b/);
});
