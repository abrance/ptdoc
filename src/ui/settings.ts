interface StoragePublic {
  access_key: string;
  bucket: string;
  domain: string;
  zone: string;
  private_bucket: boolean;
  url_ttl: number;
  secret_configured: boolean;
  verified: boolean;
}

export function initSettingsPanel(opts: {
  onStatus: (msg: string, isError?: boolean) => void;
}): { toggle: () => void } {
  let drawer: HTMLElement | null = null;

  const ensure = (): HTMLElement => {
    if (drawer && document.body.contains(drawer)) return drawer;
    drawer = document.createElement('div');
    drawer.id = 'settings-drawer';
    drawer.className = 'drawer settings-drawer';
    drawer.innerHTML = `
      <div class="drawer-head">
        <span class="drawer-title">设置</span>
        <button id="settings-close" type="button">✕</button>
      </div>
      <form id="settings-form" class="settings-form">
        <h3>对象存储（七牛云）</h3>
        <p class="settings-hint" id="storage-hint"></p>
        <label>AccessKey<input name="access_key" autocomplete="off" /></label>
        <label>SecretKey<input name="secret_key" type="password" autocomplete="off" placeholder="" /></label>
        <label>Bucket<input name="bucket" /></label>
        <label>Domain<input name="domain" placeholder="https://cdn.example.com" /></label>
        <label>区域
          <select name="zone">
            <option value="Zone_z0">华东 Zone_z0</option>
            <option value="Zone_z1">华北 Zone_z1</option>
            <option value="Zone_z2">华南 Zone_z2</option>
            <option value="Zone_na0">北美 Zone_na0</option>
            <option value="Zone_as0">东南亚 Zone_as0</option>
          </select>
        </label>
        <label class="chk"><input name="private_bucket" type="checkbox" /> 私有桶</label>
        <label>签名有效期（秒）<input name="url_ttl" type="number" min="60" value="3600" /></label>
        <div class="settings-ops">
          <button type="button" id="storage-test">测试连通性</button>
          <button type="submit">保存</button>
        </div>
        <h3>修改密码</h3>
        <label>原密码<input name="old_password" type="password" autocomplete="current-password" /></label>
        <label>新密码<input name="new_password" type="password" autocomplete="new-password" /></label>
        <button type="button" id="password-save">更新密码</button>
        <h3>API Token</h3>
        <p class="settings-hint" id="api-token-hint"></p>
        <label>新 Token<input name="api_token" autocomplete="off" placeholder="16–64 位字母或数字" /></label>
        <div class="settings-ops">
          <button type="button" id="api-token-save">保存 Token</button>
          <button type="button" id="api-token-clear">清空 Token</button>
        </div>
      </form>`;
    document.body.appendChild(drawer);
    document.getElementById('settings-close')!.addEventListener('click', () => drawer!.classList.remove('open'));
    document.getElementById('storage-test')!.addEventListener('click', () => void test());
    document.getElementById('password-save')!.addEventListener('click', () => void changePassword());
    document.getElementById('api-token-save')!.addEventListener('click', () => void saveApiToken());
    document.getElementById('api-token-clear')!.addEventListener('click', () => void clearApiToken());
    (document.getElementById('settings-form') as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      void save();
    });
    return drawer;
  };

  const collect = () => {
    const form = document.getElementById('settings-form') as HTMLFormElement;
    const fd = new FormData(form);
    const secret = String(fd.get('secret_key') || '');
    const body: Record<string, unknown> = {
      access_key: String(fd.get('access_key') || ''),
      bucket: String(fd.get('bucket') || ''),
      domain: String(fd.get('domain') || ''),
      zone: String(fd.get('zone') || 'Zone_z0'),
      private_bucket: (form.elements.namedItem('private_bucket') as HTMLInputElement).checked,
      url_ttl: Number(fd.get('url_ttl') || 3600),
    };
    if (secret) body.secret_key = secret;
    return body;
  };

  const fill = async (): Promise<void> => {
    const hint = document.getElementById('storage-hint') as HTMLElement;
    const res = await fetch('/api/storage');
    const p = (await res.json()) as StoragePublic;
    const form = document.getElementById('settings-form') as HTMLFormElement;
    (form.elements.namedItem('access_key') as HTMLInputElement).value = p.access_key;
    (form.elements.namedItem('bucket') as HTMLInputElement).value = p.bucket;
    (form.elements.namedItem('domain') as HTMLInputElement).value = p.domain;
    (form.elements.namedItem('zone') as HTMLSelectElement).value = p.zone || 'Zone_z0';
    (form.elements.namedItem('private_bucket') as HTMLInputElement).checked = p.private_bucket;
    (form.elements.namedItem('url_ttl') as HTMLInputElement).value = String(p.url_ttl || 3600);
    const sk = form.elements.namedItem('secret_key') as HTMLInputElement;
    sk.value = '';
    sk.placeholder = p.secret_configured ? '已配置（留空则保持原值）' : '未配置';
    hint.textContent = p.verified ? '当前配置已通过连通性校验' : '尚未保存可用的对象存储配置';
    await fillApiToken();
  };

  const test = async (): Promise<void> => {
    try {
      const res = await fetch('/api/storage/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect()),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error || '测试失败');
      opts.onStatus('对象存储连通性正常');
    } catch (e) {
      opts.onStatus((e as Error).message, true);
    }
  };

  const save = async (): Promise<void> => {
    try {
      const res = await fetch('/api/storage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect()),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error || '保存失败');
      opts.onStatus('对象存储配置已保存');
      await fill();
    } catch (e) {
      opts.onStatus((e as Error).message, true);
    }
  };

  const changePassword = async (): Promise<void> => {
    const form = document.getElementById('settings-form') as HTMLFormElement;
    const old_password = (form.elements.namedItem('old_password') as HTMLInputElement).value;
    const new_password = (form.elements.namedItem('new_password') as HTMLInputElement).value;
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password, new_password }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error || '改密失败');
      opts.onStatus('密码已更新');
    } catch (e) {
      opts.onStatus((e as Error).message, true);
    }
  };

  const fillApiToken = async (): Promise<void> => {
    const hint = document.getElementById('api-token-hint') as HTMLElement;
    const input = (document.getElementById('settings-form') as HTMLFormElement).elements.namedItem(
      'api_token',
    ) as HTMLInputElement;
    const clearBtn = document.getElementById('api-token-clear') as HTMLButtonElement;
    const res = await fetch('/api/auth/me');
    const me = (await res.json()) as { has_api_token?: boolean };
    const configured = !!me.has_api_token;
    hint.textContent = configured ? '已配置（服务端不保存明文，填写新值即可轮换）' : '未配置';
    input.value = '';
    clearBtn.disabled = !configured;
  };

  const saveApiToken = async (): Promise<void> => {
    const form = document.getElementById('settings-form') as HTMLFormElement;
    const token = (form.elements.namedItem('api_token') as HTMLInputElement).value;
    try {
      const res = await fetch('/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error || '保存 Token 失败');
      opts.onStatus('API Token 已保存');
      await fillApiToken();
    } catch (e) {
      opts.onStatus((e as Error).message, true);
    }
  };

  const clearApiToken = async (): Promise<void> => {
    try {
      const res = await fetch('/api/auth/token', { method: 'DELETE' });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error || '清空 Token 失败');
      opts.onStatus('API Token 已清空');
      await fillApiToken();
    } catch (e) {
      opts.onStatus((e as Error).message, true);
    }
  };

  return {
    toggle: () => {
      const d = ensure();
      d.classList.toggle('open');
      if (d.classList.contains('open')) void fill();
    },
  };
}
