function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function mountDialog(html: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop open';
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  return wrap;
}

export function askConfirm(message: string, opts?: { title?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = mountDialog(`
      <div class="modal dialog-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <span>${esc(opts?.title || '确认')}</span>
          <button type="button" class="icon-btn" data-act="cancel" aria-label="关闭">
            <svg class="icon"><use href="#i-close"></use></svg>
          </button>
        </div>
        <div class="dialog-body">${esc(message)}</div>
        <div class="modal-foot">
          <button type="button" data-act="cancel">取消</button>
          <button type="button" class="${opts?.danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(opts?.confirmLabel || '确定')}</button>
        </div>
      </div>`);
    const done = (ok: boolean): void => {
      wrap.remove();
      resolve(ok);
    };
    wrap.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (e.target === wrap || act === 'cancel') done(false);
      else if (act === 'ok') done(true);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(false);
    });
    (wrap.querySelector('[data-act="ok"]') as HTMLButtonElement).focus();
  });
}

export function askText(opts: {
  title: string;
  label: string;
  value?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = mountDialog(`
      <div class="modal dialog-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <span>${esc(opts.title)}</span>
          <button type="button" class="icon-btn" data-act="cancel" aria-label="关闭">
            <svg class="icon"><use href="#i-close"></use></svg>
          </button>
        </div>
        <form class="dialog-form">
          <label class="dialog-field">${esc(opts.label)}
            <input name="value" value="${esc(opts.value || '')}" autocomplete="off" />
          </label>
          <div class="modal-foot">
            <button type="button" data-act="cancel">取消</button>
            <button type="submit" class="btn-primary">${esc(opts.confirmLabel || '确定')}</button>
          </div>
        </form>
      </div>`);
    const input = wrap.querySelector('input') as HTMLInputElement;
    const done = (value: string | null): void => {
      wrap.remove();
      resolve(value);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || (e.target as HTMLElement).closest('[data-act="cancel"]')) done(null);
    });
    wrap.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      done(input.value);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
    });
    input.focus();
    input.select();
  });
}
