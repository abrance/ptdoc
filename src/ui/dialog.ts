// ─── 应用内确认 / 输入对话框 ─────────────────────────────
// 替掉 window.confirm / window.prompt：原生框在深色主题下是纯白闪一下、多行文案排不了版、
// 移动端 Safari 对 prompt 支持很差，还没法给危险操作标红。
//
// 用原生 <dialog> + showModal()：焦点陷阱、Esc 关闭、top-layer 都是平台自带的，
// 不需要手写。取消/确定用 <form method="dialog"> 的 returnValue 传出来，
// 所有关闭路径（Esc / 遮罩 / 按钮）都汇合到 `close` 事件，Promise 不会悬挂。

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

interface DialogShell {
  dlg: HTMLDialogElement;
  result: Promise<string | null>; // 关闭时的 returnValue，取消统一为 null
}

function mountDialog(title: string, bodyHtml: string, footHtml: string): DialogShell {
  const dlg = document.createElement('dialog');
  dlg.className = 'app-dialog';
  dlg.setAttribute('aria-label', title);
  dlg.innerHTML = `
    <form method="dialog" class="dialog-form">
      <div class="dialog-head">
        <span class="dialog-title">${esc(title)}</span>
        <button type="button" class="dialog-x" data-act="cancel" aria-label="取消">✕</button>
      </div>
      ${bodyHtml}
      <div class="dialog-foot">${footHtml}</div>
    </form>`;

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const result = new Promise<string | null>((resolve) => {
    dlg.addEventListener(
      'close',
      () => {
        const value = dlg.returnValue || null;
        dlg.remove();
        // 焦点还给打开对话框的那个按钮，键盘用户不丢位置
        previouslyFocused?.focus?.();
        resolve(value);
      },
      { once: true },
    );
  });

  dlg.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === dlg) dlg.close(); // 点遮罩区域
    else if (target.closest('[data-act="cancel"]')) dlg.close();
  });

  document.body.appendChild(dlg);
  dlg.showModal();
  return { dlg, result };
}

/** 确认框。取消 / Esc / 点遮罩 → false。 */
export async function askConfirm(
  message: string,
  opts?: { title?: string; confirmLabel?: string; danger?: boolean },
): Promise<boolean> {
  const { dlg, result } = mountDialog(
    opts?.title ?? '确认',
    `<div class="dialog-body">${esc(message)}</div>`,
    `<button type="button" data-act="cancel">取消</button>
     <button type="submit" value="ok" class="${opts?.danger ? 'btn-danger' : 'btn-primary'}">${esc(opts?.confirmLabel ?? '确定')}</button>`,
  );
  (dlg.querySelector('[value="ok"]') as HTMLButtonElement)?.focus();
  return (await result) === 'ok';
}

/**
 * 归档确认框：说明 + 可留空的备注输入。取消 → null；确定 → 备注（可能是空串）。
 * 备注为空是合法输入，所以不能用 askText 的 null 表示取消。
 */
export async function askNote(opts: {
  title: string;
  message: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  const { dlg, result } = mountDialog(
    opts.title,
    `<div class="dialog-body">${esc(opts.message)}</div>
     <label class="dialog-field">${esc(opts.label)}
       <input name="value" type="text" placeholder="${esc(opts.placeholder ?? '')}"
              autocomplete="off" spellcheck="false" />
     </label>`,
    `<button type="button" data-act="cancel">取消</button>
     <button type="submit" value="ok" class="btn-primary">${esc(opts.confirmLabel ?? '归档')}</button>`,
  );
  const input = dlg.querySelector('input') as HTMLInputElement;
  input.focus();
  const ok = (await result) === 'ok';
  return ok ? input.value.trim() : null;
}

/** 下拉选择。取消 / Esc / 点遮罩 → null；确定 → 选中的 value。 */
export async function askSelect(opts: {
  title: string;
  message?: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  value?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  const optionsHtml = opts.options
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.value === opts.value ? ' selected' : ''}>${esc(o.label)}</option>`,
    )
    .join('');
  const body =
    (opts.message ? `<div class="dialog-body">${esc(opts.message)}</div>` : '') +
    `<label class="dialog-field">${esc(opts.label)}
       <select name="value">${optionsHtml}</select>
     </label>`;
  const { dlg, result } = mountDialog(
    opts.title,
    body,
    `<button type="button" data-act="cancel">取消</button>
     <button type="submit" value="ok" class="btn-primary">${esc(opts.confirmLabel ?? '确定')}</button>`,
  );
  const select = dlg.querySelector('select') as HTMLSelectElement;
  select.focus();
  return (await result) === 'ok' ? select.value : null;
}

/** 输入框。取消 / Esc / 点遮罩 → null。 */
export async function askText(opts: {  title: string;
  label: string;
  value?: string;
  /** 密码类输入用 password，不回显（原生 prompt 是明文的） */
  type?: 'text' | 'password';
  confirmLabel?: string;
}): Promise<string | null> {
  const { dlg, result } = mountDialog(
    opts.title,
    `<label class="dialog-field">${esc(opts.label)}
       <input name="value" type="${opts.type ?? 'text'}" value="${esc(opts.value ?? '')}"
              autocomplete="off" spellcheck="false" />
     </label>`,
    `<button type="button" data-act="cancel">取消</button>
     <button type="submit" value="ok" class="btn-primary">${esc(opts.confirmLabel ?? '确定')}</button>`,
  );
  const input = dlg.querySelector('input') as HTMLInputElement;
  input.focus();
  input.select();
  return (await result) === 'ok' ? input.value : null;
}
