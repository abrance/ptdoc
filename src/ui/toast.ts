// ─── 瞬时提示浮层 ───────────────────────────────────────
// 状态栏那行文字会被下一次操作覆盖，错误又不该一直挂着；需要「看得见、自己会走」的反馈时用它。
// aria-live=polite：读屏会念出来，但不会打断用户当前操作。
//
// 带 action 的提示不会自动消失：失败后还能重试的那条通路必须留在屏幕上，
// 否则用户只剩「再点一次同样的按钮」这一条模模糊糊的路。

export type ToastKind = 'info' | 'success' | 'error';

export type ToastAction = {
  label: string;
  onClick: () => void;
};

const HOST_ID = 'toasts';

export function showToast(msg: string, kind: ToastKind = 'info', action?: ToastAction): void {
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
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  el.appendChild(text);

  if (action) {
    // 带按钮的提示不会自己走，重复失败会越堆越多；只保留最新一条。
    host.querySelectorAll('.toast.has-action').forEach((n) => n.remove());
    el.classList.add('has-action');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.remove();
      action.onClick();
    });
    el.appendChild(btn);
  }

  host.appendChild(el);
  if (action) return;
  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 180);
  }, 4000);
}
