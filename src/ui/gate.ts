export interface SessionUser {
  id: number;
  username: string;
  role: 'admin' | 'member';
  status: string;
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error || 'HTTP ' + res.status;
  } catch {
    return 'HTTP ' + res.status;
  }
}

function mountGate(html: string): HTMLElement {
  let el = document.getElementById('auth-gate');
  if (!el) {
    el = document.createElement('div');
    el.id = 'auth-gate';
    document.body.appendChild(el);
  }
  el.className = 'auth-gate';
  el.innerHTML = html;
  el.hidden = false;
  return el;
}

function hideGate(): void {
  const el = document.getElementById('auth-gate');
  if (el) el.hidden = true;
}

function formHtml(title: string, extraLink: string, submitLabel: string): string {
  return `
    <div class="auth-card">
      <h1>${title}</h1>
      <p class="auth-hint" id="auth-hint"></p>
      <form id="auth-form">
        <label>用户名<input name="username" autocomplete="username" required minlength="3" maxlength="32" /></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="72" /></label>
        <button type="submit">${submitLabel}</button>
      </form>
      ${extraLink}
    </div>`;
}

export async function startGate(onReady: (user: SessionUser) => void): Promise<void> {
  const st = await fetch('/api/setup/status').then((r) => r.json() as Promise<{ initialized: boolean }>);
  if (!st.initialized) {
    showSetup(onReady);
    return;
  }
  const me = await fetch('/api/auth/me');
  if (me.ok) {
    hideGate();
    onReady((await me.json()) as SessionUser);
    return;
  }
  showLogin(onReady);
}

function showSetup(onReady: (user: SessionUser) => void): void {
  mountGate(formHtml('初始化 PTDoc', '<p class="auth-sub">创建首位平台管理员。此后其他人可自行注册为成员。</p>', '创建管理员并进入'));
  bindForm('/api/setup', onReady, '初始化失败');
}

function showLogin(onReady: (user: SessionUser) => void): void {
  mountGate(
    formHtml(
      '登录 PTDoc',
      '<p class="auth-sub"><button type="button" id="goto-register" class="linkish">没有账号？注册</button></p>',
      '登录',
    ),
  );
  document.getElementById('goto-register')?.addEventListener('click', () => showRegister(onReady));
  bindForm('/api/auth/login', onReady, '登录失败');
}

function showRegister(onReady: (user: SessionUser) => void): void {
  mountGate(
    formHtml(
      '注册',
      '<p class="auth-sub"><button type="button" id="goto-login" class="linkish">已有账号？登录</button></p>',
      '注册并进入',
    ),
  );
  document.getElementById('goto-login')?.addEventListener('click', () => showLogin(onReady));
  bindForm('/api/auth/register', onReady, '注册失败');
}

function bindForm(url: string, onReady: (user: SessionUser) => void, failPrefix: string): void {
  const form = document.getElementById('auth-form') as HTMLFormElement;
  const hint = document.getElementById('auth-hint') as HTMLElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hint.textContent = '';
    const fd = new FormData(form);
    const body = {
      username: String(fd.get('username') || ''),
      password: String(fd.get('password') || ''),
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      const user = (await res.json()) as SessionUser;
      hideGate();
      onReady(user);
    } catch (err) {
      hint.textContent = failPrefix + '：' + (err as Error).message;
    }
  });
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}
