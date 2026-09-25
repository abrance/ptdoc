// ─── 瞬时提示浮层 ───────────────────────────────────────
// 状态栏那行文字会被下一次操作覆盖，错误又不该一直挂着；需要「看得见、自己会走」的反馈时用它。
// aria-live=polite：读屏会念出来，但不会打断用户当前操作。

export type ToastKind = 'info' | 'success' | 'error';

const HOST_ID = 'toasts';

export function showToast(msg: string, kind: ToastKind = 'info'): void {
  if (!msg) return;
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.className = 'toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.textContent = msg;
  host.appendChild(el);
  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 180);
  }, 4000);
}
