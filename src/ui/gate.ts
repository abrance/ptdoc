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
  // 工作区已 inert，焦点只能在卡片里；不主动交出焦点的话，首次 Tab 可能落到浏览器地址栏。
  (el.querySelector('input, button') as HTMLElement | null)?.focus();
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

/** 门禁的两个往返：先问是否已初始化，再问我是谁。
 *  任何一步 reject（断网、后端 500、返回体不是 JSON）都由 startGate 兜住，不许静默冒泡。 */
async function resolveGate(): Promise<SessionUser | 'setup' | 'login'> {
  const res = await fetch('/api/setup/status');
  if (!res.ok) throw new Error('初始化状态查询失败：' + (await readError(res)));
  const st = (await res.json()) as { initialized: boolean };
  if (!st.initialized) return 'setup';
  const me = await fetch('/api/auth/me');
  if (me.ok) return (await me.json()) as SessionUser;
  return 'login';
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** 门禁自己挂了，也必须给出一张能重试的卡：
 *  以前 `void startGate(...)` 无 catch，fetch 抛错就 showLogin/showSetup 都不调，
 *  #app 永远 hidden → 用户看到纯白页，连登录框都没有（比首屏闪一下更糟）。 */
function showGateError(onReady: (user: SessionUser) => void, message: string): void {
  mountGate(`
    <div class="auth-card">
      <h1>无法连接服务</h1>
      <p class="auth-hint">${esc(message)}</p>
      <p class="auth-sub">登录态未知，工作区保持锁定。确认后端在运行后重试。</p>
      <button type="button" id="gate-retry">重试</button>
    </div>`);
  const retry = document.getElementById('gate-retry') as HTMLButtonElement | null;
  retry?.addEventListener('click', () => {
    retry.disabled = true;
    retry.textContent = '重试中…';
    void startGate(onReady);
  });
}

export async function startGate(onReady: (user: SessionUser) => void): Promise<void> {
  let state: SessionUser | 'setup' | 'login';
  try {
    state = await resolveGate();
  } catch (err) {
    showGateError(onReady, (err as Error).message || String(err));
    return;
  }
  if (state === 'setup') {
    showSetup(onReady);
    return;
  }
  if (state === 'login') {
    showLogin(onReady);
    return;
  }
  // onReady 放在 try 外：登录已成功，工作区初始化自己出错时不该被误画成门禁错误卡。
  hideGate();
  onReady(state);
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
