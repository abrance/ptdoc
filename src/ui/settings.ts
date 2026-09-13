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
        <h3>大模型（OpenAI 兼容）</h3>
        <p class="settings-hint" id="llm-hint"></p>
        <label>Base URL<input name="llm_base_url" placeholder="https://api.deepseek.com/v1" /></label>
        <label>模型名<input name="llm_model" placeholder="deepseek-chat" /></label>
        <label>API Key<input name="llm_api_key" type="password" autocomplete="off" /></label>
        <button type="button" id="llm-save">保存大模型</button>
        <h3>知识库（Qdrant）</h3>
        <p class="settings-hint" id="qdrant-hint"></p>
        <label>URL<input name="qdrant_url" placeholder="http://qdrant:6333" /></label>
        <label>Collection<input name="qdrant_collection" /></label>
        <label>Vector 名（可选）<input name="qdrant_vector" /></label>
        <label>top-k<input name="qdrant_topk" type="number" min="1" max="20" value="5" /></label>
        <label>API Key<input name="qdrant_api_key" type="password" autocomplete="off" /></label>
        <button type="button" id="qdrant-save">保存知识库</button>
      <h3>修改密码</h3>
        <label>原密码<input name="old_password" type="password" autocomplete="current-password" /></label>
        <label>新密码<input name="new_password" type="password" autocomplete="new-password" /></label>
        <button type="button" id="password-save">更新密码</button>
      </form>`;
    document.body.appendChild(drawer);
    document.getElementById('settings-close')!.addEventListener('click', () => drawer!.classList.remove('open'));
    document.getElementById('storage-test')!.addEventListener('click', () => void test());
    document.getElementById('password-save')!.addEventListener('click', () => void changePassword());
    document.getElementById('llm-save')!.addEventListener('click', () => void saveLlm());
    document.getElementById('qdrant-save')!.addEventListener('click', () => void saveQdrant());
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
    await fillLlm();
    await fillQdrant();
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

  const fillLlm = async (): Promise<void> => {
    const res = await fetch('/api/agents/llm');
    const p = (await res.json()) as { base_url: string; model: string; secret_configured: boolean };
    const form = document.getElementById('settings-form') as HTMLFormElement;
    (form.elements.namedItem('llm_base_url') as HTMLInputElement).value = p.base_url;
    (form.elements.namedItem('llm_model') as HTMLInputElement).value = p.model;
    const key = form.elements.namedItem('llm_api_key') as HTMLInputElement;
    key.value = '';
    key.placeholder = p.secret_configured ? '已配置（留空则保持原值）' : '未配置';
    (document.getElementById('llm-hint') as HTMLElement).textContent = p.secret_configured ? '已保存' : '尚未配置';
  };

  const fillQdrant = async (): Promise<void> => {
    const res = await fetch('/api/agents/qdrant');
    const p = (await res.json()) as {
      url: string;
      collection: string;
      vector_name: string;
      top_k: number;
      secret_configured: boolean;
    };
    const form = document.getElementById('settings-form') as HTMLFormElement;
    (form.elements.namedItem('qdrant_url') as HTMLInputElement).value = p.url;
    (form.elements.namedItem('qdrant_collection') as HTMLInputElement).value = p.collection;
    (form.elements.namedItem('qdrant_vector') as HTMLInputElement).value = p.vector_name;
    (form.elements.namedItem('qdrant_topk') as HTMLInputElement).value = String(p.top_k || 5);
    const key = form.elements.namedItem('qdrant_api_key') as HTMLInputElement;
    key.value = '';
    key.placeholder = p.secret_configured ? '已配置（留空则保持原值）' : '可选';
    (document.getElementById('qdrant-hint') as HTMLElement).textContent = p.url ? '已保存' : '尚未配置';
  };

  const saveLlm = async (): Promise<void> => {
    const form = document.getElementById('settings-form') as HTMLFormElement;
    const body: Record<string, unknown> = {
      base_url: (form.elements.namedItem('llm_base_url') as HTMLInputElement).value,
      model: (form.elements.namedItem('llm_model') as HTMLInputElement).value,
    };
    const key = (form.elements.namedItem('llm_api_key') as HTMLInputElement).value.trim();
    if (key) body.api_key = key;
    const res = await fetch('/api/agents/llm', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '保存失败', true);
    opts.onStatus('大模型配置已保存');
    await fillLlm();
  };

  const saveQdrant = async (): Promise<void> => {
    const form = document.getElementById('settings-form') as HTMLFormElement;
    const body: Record<string, unknown> = {
      url: (form.elements.namedItem('qdrant_url') as HTMLInputElement).value,
      collection: (form.elements.namedItem('qdrant_collection') as HTMLInputElement).value,
      vector_name: (form.elements.namedItem('qdrant_vector') as HTMLInputElement).value,
      top_k: Number((form.elements.namedItem('qdrant_topk') as HTMLInputElement).value || 5),
    };
    const key = (form.elements.namedItem('qdrant_api_key') as HTMLInputElement).value.trim();
    if (key) body.api_key = key;
    const res = await fetch('/api/agents/qdrant', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '保存失败', true);
    opts.onStatus('知识库配置已保存');
    await fillQdrant();
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

  return {
    toggle: () => {
      const d = ensure();
      d.classList.toggle('open');
      if (d.classList.contains('open')) void fill();
    },
  };
}
