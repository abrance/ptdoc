const HOST_ID = 'toasts';

export type ToastKind = 'info' | 'success' | 'error';

export function showToast(msg: string, kind: ToastKind = 'info'): void {
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
