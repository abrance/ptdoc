interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  created_at: number;
}

export function initAdminPanel(opts: {
  onStatus: (msg: string, isError?: boolean) => void;
}): { toggle: () => void } {
  let drawer: HTMLElement | null = null;

  const ensure = (): HTMLElement => {
    if (drawer && document.body.contains(drawer)) return drawer;
    drawer = document.createElement('div');
    drawer.id = 'admin-drawer';
    drawer.className = 'drawer';
    drawer.innerHTML = `
      <div class="drawer-head">
        <span class="drawer-title">账号管理</span>
        <button id="admin-close" type="button">✕</button>
      </div>
      <ul id="admin-list" class="history-list"></ul>`;
    document.body.appendChild(drawer);
    document.getElementById('admin-close')!.addEventListener('click', () => drawer!.classList.remove('open'));
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
    return drawer;
  };

  const refresh = async (): Promise<void> => {
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

  const changeRole = async (id: number, role: 'admin' | 'member'): Promise<void> => {
    const res = await fetch(`/api/admin/users/${id}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '失败', true);
    opts.onStatus('已更新角色');
    void refresh();
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
    void refresh();
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
      if (d.classList.contains('open')) void refresh();
    },
  };
}
