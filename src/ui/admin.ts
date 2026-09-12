interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  created_at: number;
}

interface ExtRow {
  id: number;
  kind: 'mcp' | 'skill' | 'plugin';
  name: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  secret_configured?: boolean;
  files?: string[];
  probe?: { tools: number; error?: string };
}

export function initAdminPanel(opts: {
  onStatus: (msg: string, isError?: boolean) => void;
}): { toggle: () => void } {
  let drawer: HTMLElement | null = null;
  let tab: 'users' | 'ext' = 'users';
  let editingId: number | null = null;
  let editingKind: ExtRow['kind'] = 'mcp';

  const ensure = (): HTMLElement => {
    if (drawer && document.body.contains(drawer)) return drawer;
    drawer = document.createElement('div');
    drawer.id = 'admin-drawer';
    drawer.className = 'drawer admin-drawer';
    drawer.innerHTML = `
      <div class="drawer-head">
        <span class="drawer-title">平台管理</span>
        <button id="admin-close" type="button">✕</button>
      </div>
      <div class="admin-tabs">
        <button type="button" data-tab="users" class="active">账号</button>
        <button type="button" data-tab="ext">智能体扩展</button>
      </div>
      <ul id="admin-list" class="history-list"></ul>
      <div id="admin-ext" class="admin-ext" hidden>
        <div class="admin-ext-bar">
          <select id="ext-kind">
            <option value="">全部类型</option>
            <option value="mcp">MCP</option>
            <option value="skill">Skill</option>
            <option value="plugin">Plugin</option>
          </select>
          <input id="ext-q" placeholder="筛选名称" />
          <button type="button" id="ext-refresh">刷新</button>
          <button type="button" id="ext-new">新建</button>
        </div>
        <ul id="ext-list" class="history-list"></ul>
        <form id="ext-form" class="settings-form">
          <h3 id="ext-form-title">新建扩展</h3>
          <label>类型
            <select name="kind">
              <option value="mcp">MCP</option>
              <option value="skill">Skill</option>
              <option value="plugin">Plugin</option>
            </select>
          </label>
          <label>名称<input name="name" required /></label>
          <div id="ext-mcp">
            <label>Transport
              <select name="transport">
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="streamable-http">streamable-http</option>
                <option value="sse">sse</option>
              </select>
            </label>
            <label>URL<input name="url" placeholder="https://..." /></label>
            <label>Command<input name="command" placeholder="npx" /></label>
            <label>Args（逗号分隔）<input name="args" /></label>
            <label>Env JSON<textarea name="env" rows="3" placeholder='{"KEY":"value"}'></textarea></label>
            <label>Headers JSON<textarea name="headers" rows="2"></textarea></label>
          </div>
          <div id="ext-zip" hidden>
            <label>Zip 包<input name="zip" type="file" accept=".zip,application/zip" /></label>
            <p class="settings-hint" id="ext-files"></p>
          </div>
          <div class="settings-ops">
            <button type="submit" id="ext-save">保存</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(drawer);
    document.getElementById('admin-close')!.addEventListener('click', () => drawer!.classList.remove('open'));
    drawer.querySelectorAll('.admin-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        tab = (btn as HTMLElement).dataset.tab as 'users' | 'ext';
        drawer!.querySelectorAll('.admin-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
        document.getElementById('admin-list')!.hidden = tab !== 'users';
        document.getElementById('admin-ext')!.hidden = tab !== 'ext';
        if (tab === 'users') void refreshUsers();
        else void refreshExt();
      });
    });
    document.getElementById('admin-list')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
      if (!btn || !li) return;
      const id = Number(li.dataset.id);
      const op = btn.dataset.op;
      if (op === 'role') void changeRole(id, btn.dataset.role as 'admin' | 'member');
      else if (op === 'status') void changeStatus(id, btn.dataset.status as 'active' | 'disabled');
      else if (op === 'reset') void resetPassword(id);
    });
    document.getElementById('ext-refresh')!.addEventListener('click', () => void refreshExt());
    document.getElementById('ext-kind')!.addEventListener('change', () => void refreshExt());
    document.getElementById('ext-q')!.addEventListener('input', () => void refreshExt());
    document.getElementById('ext-new')!.addEventListener('click', () => resetForm());
    (document.getElementById('ext-form') as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      void saveExt();
    });
    (document.querySelector('#ext-form [name="kind"]') as HTMLSelectElement).addEventListener('change', syncKindUi);
    document.getElementById('ext-list')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
      if (!li) return;
      const id = Number(li.dataset.id);
      if (btn?.dataset.op === 'enable') {
        void extAction(id, 'enable');
        return;
      }
      if (btn?.dataset.op === 'disable') {
        void extAction(id, 'disable');
        return;
      }
      if (btn?.dataset.op === 'del') {
        if (!confirm('确认删除该扩展？文件目录会一并移除。')) return;
        void extAction(id, 'delete');
        return;
      }
      void loadExt(id);
    });
    return drawer;
  };

  const refreshUsers = async (): Promise<void> => {
    const list = document.getElementById('admin-list') as HTMLElement;
    list.innerHTML = '<li class="empty">加载中…</li>';
    try {
      const res = await fetch('/api/admin/users');
      if (!res.ok) throw new Error('权限不足');
      const rows = (await res.json()) as AdminUser[];
      list.innerHTML = '';
      for (const u of rows) {
        const li = document.createElement('li');
        li.className = 'history-item';
        li.dataset.id = String(u.id);
        const when = new Date(u.created_at).toLocaleString();
        const nextRole = u.role === 'admin' ? 'member' : 'admin';
        const nextStatus = u.status === 'active' ? 'disabled' : 'active';
        li.innerHTML = `<div class="hi-title">${u.username}</div>
          <div class="hi-meta">${u.role} · ${u.status} · ${when}</div>
          <div class="share-row-ops">
            <button type="button" data-op="role" data-role="${nextRole}">改为 ${nextRole}</button>
            <button type="button" data-op="status" data-status="${nextStatus}">${nextStatus === 'disabled' ? '停用' : '启用'}</button>
            <button type="button" data-op="reset">重置密码</button>
          </div>`;
        list.appendChild(li);
      }
    } catch (e) {
      list.innerHTML = '<li class="empty">' + (e as Error).message + '</li>';
    }
  };

  const syncKindUi = (): void => {
    const kind = (document.querySelector('#ext-form [name="kind"]') as HTMLSelectElement).value;
    document.getElementById('ext-mcp')!.hidden = kind !== 'mcp';
    document.getElementById('ext-zip')!.hidden = kind === 'mcp';
  };

  const resetForm = (): void => {
    editingId = null;
    editingKind = 'mcp';
    const form = document.getElementById('ext-form') as HTMLFormElement;
    form.reset();
    (form.elements.namedItem('kind') as HTMLSelectElement).disabled = false;
    document.getElementById('ext-form-title')!.textContent = '新建扩展';
    document.getElementById('ext-files')!.textContent = '';
    syncKindUi();
  };

  const refreshExt = async (): Promise<void> => {
    const kind = (document.getElementById('ext-kind') as HTMLSelectElement).value;
    const q = (document.getElementById('ext-q') as HTMLInputElement).value.trim();
    const qs = new URLSearchParams();
    if (kind) qs.set('kind', kind);
    if (q) qs.set('q', q);
    const res = await fetch('/api/admin/extensions' + (qs.toString() ? '?' + qs : ''));
    const rows = (await res.json()) as ExtRow[];
    const list = document.getElementById('ext-list')!;
    if (!res.ok) {
      list.innerHTML = '<li class="empty">加载失败</li>';
      return;
    }
    list.innerHTML = rows
      .map(
        (r) => `<li class="history-item${r.id === editingId ? ' active' : ''}" data-id="${r.id}">
          <div class="hi-title">${r.name}</div>
          <div class="hi-meta">${r.kind} · ${r.enabled ? '启用' : '停用'}</div>
          <div class="share-row-ops">
            <button type="button" data-op="${r.enabled ? 'disable' : 'enable'}">${r.enabled ? '停用' : '启用'}</button>
            <button type="button" data-op="del">删除</button>
          </div>
        </li>`,
      )
      .join('');
    if (!rows.length) list.innerHTML = '<li class="empty">暂无扩展</li>';
  };

  const loadExt = async (id: number): Promise<void> => {
    const res = await fetch('/api/admin/extensions/' + id);
    const r = (await res.json()) as ExtRow & { error?: string };
    if (!res.ok) return opts.onStatus(r.error || '加载失败', true);
    editingId = r.id;
    editingKind = r.kind;
    const form = document.getElementById('ext-form') as HTMLFormElement;
    (form.elements.namedItem('kind') as HTMLSelectElement).value = r.kind;
    (form.elements.namedItem('kind') as HTMLSelectElement).disabled = true;
    (form.elements.namedItem('name') as HTMLInputElement).value = r.name;
    const cfg = r.config || {};
    (form.elements.namedItem('transport') as HTMLSelectElement).value = String(cfg.transport || 'stdio');
    (form.elements.namedItem('url') as HTMLInputElement).value = String(cfg.url || '');
    (form.elements.namedItem('command') as HTMLInputElement).value = String(cfg.command || '');
    (form.elements.namedItem('args') as HTMLInputElement).value = Array.isArray(cfg.args) ? cfg.args.join(',') : '';
    (form.elements.namedItem('env') as HTMLTextAreaElement).value = '';
    (form.elements.namedItem('headers') as HTMLTextAreaElement).value = '';
    document.getElementById('ext-form-title')!.textContent = '编辑 ' + r.name;
    document.getElementById('ext-files')!.textContent = r.files?.length
      ? '现有文件：' + r.files.join(', ')
      : r.secret_configured
        ? '已配置密钥'
        : '';
    syncKindUi();
    void refreshExt();
  };

  const parseJsonField = (raw: string, label: string): unknown => {
    const t = raw.trim();
    if (!t) return undefined;
    try {
      return JSON.parse(t);
    } catch {
      throw new Error(label + ' 不是合法 JSON');
    }
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });

  const saveExt = async (): Promise<void> => {
    const form = document.getElementById('ext-form') as HTMLFormElement;
    const kind = ((form.elements.namedItem('kind') as HTMLSelectElement).value || editingKind) as ExtRow['kind'];
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    if (!name) return opts.onStatus('名称不能为空', true);
    if (editingId && !confirm('确认覆盖保存该扩展？')) return;
    try {
      if (kind === 'mcp') {
        const body: Record<string, unknown> = {
          name,
          transport: (form.elements.namedItem('transport') as HTMLSelectElement).value,
          url: (form.elements.namedItem('url') as HTMLInputElement).value.trim(),
          command: (form.elements.namedItem('command') as HTMLInputElement).value.trim(),
        };
        const args = (form.elements.namedItem('args') as HTMLInputElement).value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (args.length) body.args = args;
        const env = parseJsonField((form.elements.namedItem('env') as HTMLTextAreaElement).value, 'Env');
        const headers = parseJsonField((form.elements.namedItem('headers') as HTMLTextAreaElement).value, 'Headers');
        if (env) body.env = env;
        if (headers) body.headers = headers;
        const url = editingId ? '/api/admin/extensions/mcp/' + editingId : '/api/admin/extensions/mcp';
        const res = await fetch(url, {
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as { error?: string; probe?: { error?: string } };
        if (!res.ok) return opts.onStatus(j.error || '保存失败', true);
        opts.onStatus(j.probe?.error ? '已保存，加载提示：' + j.probe.error : 'MCP 已保存');
      } else {
        const zipInput = form.elements.namedItem('zip') as HTMLInputElement;
        const file = zipInput.files?.[0];
        if (!file) return opts.onStatus('请选择 zip 文件', true);
        const zip_base64 = await fileToBase64(file);
        const pathKind = kind === 'skill' ? 'skills' : 'plugins';
        const url = editingId
          ? `/api/admin/extensions/${pathKind}/${editingId}`
          : `/api/admin/extensions/${pathKind}`;
        const res = await fetch(url, {
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, zip_base64 }),
        });
        const j = (await res.json()) as { error?: string; probe?: { error?: string } };
        if (!res.ok) return opts.onStatus(j.error || '保存失败', true);
        opts.onStatus(j.probe?.error ? '已保存，加载提示：' + j.probe.error : '扩展已保存');
        zipInput.value = '';
      }
      resetForm();
      await refreshExt();
    } catch (e) {
      opts.onStatus((e as Error).message, true);
    }
  };

  const extAction = async (id: number, op: 'enable' | 'disable' | 'delete'): Promise<void> => {
    const url =
      op === 'delete' ? '/api/admin/extensions/' + id : `/api/admin/extensions/${id}/${op}`;
    const res = await fetch(url, { method: op === 'delete' ? 'DELETE' : 'POST' });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '失败', true);
    if (editingId === id) resetForm();
    opts.onStatus(op === 'delete' ? '已删除' : op === 'enable' ? '已启用' : '已停用');
    await refreshExt();
  };

  const changeRole = async (id: number, role: 'admin' | 'member'): Promise<void> => {
    const res = await fetch(`/api/admin/users/${id}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '失败', true);
    opts.onStatus('已更新角色');
    void refreshUsers();
  };

  const changeStatus = async (id: number, status: 'active' | 'disabled'): Promise<void> => {
    const res = await fetch(`/api/admin/users/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '失败', true);
    opts.onStatus(status === 'disabled' ? '已停用' : '已启用');
    void refreshUsers();
  };

  const resetPassword = async (id: number): Promise<void> => {
    const password = prompt('新密码（至少 8 位）');
    if (!password) return;
    const res = await fetch(`/api/admin/users/${id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '失败', true);
    opts.onStatus('已重置密码，该用户需重新登录');
  };

  return {
    toggle: () => {
      const d = ensure();
      d.classList.toggle('open');
      if (d.classList.contains('open')) {
        if (tab === 'users') void refreshUsers();
        else void refreshExt();
      }
    },
  };
}
