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

/** 设置分区 id（Sider 导航、抽屉手风琴共用） */
const SECTIONS = ['storage', 'llm', 'qdrant', 'password', 'token'] as const;
export type SettingsSectionId = (typeof SECTIONS)[number];

const SECTION_TITLES: Record<SettingsSectionId, string> = {
  storage: '对象存储（七牛云）',
  llm: '大模型（OpenAI 兼容）',
  qdrant: '知识库（Qdrant）',
  password: '修改密码',
  token: 'API Token',
};

/** 模块级配置状态存储：供 Sider 导航状态灯直接读取（不依赖面板实例） */
const settingsConfigured: Partial<Record<SettingsSectionId, boolean>> = {};

/** 把模块级状态刷到 Sider 导航的迷你状态灯上（app.ts 在打开设置页时调用） */
export function syncSettingsDots(): void {
  for (const id of SECTIONS) {
    const on = !!settingsConfigured[id];
    for (const navDot of document.querySelectorAll(`[data-nav-dot="${id}"]`)) {
      navDot.className = 'settings-dot mini' + (on ? ' on' : '');
    }
  }
}

export function initSettingsPanel(opts: {
  onStatus: (msg: string, isError?: boolean) => void;
}): {
  /** 打开设置主界面并展开指定分区（Sider 配置项导航回调） */
  openSection: (section: SettingsSectionId) => void;
} {
  // 设置手风琴渲染进设置主界面容器（#settings-main-area），不再是抽屉
  const root = (): HTMLElement | null => document.getElementById('settings-main-area');
  let built = false;
  // 各分区「已配置」状态（驱动 Sider 状态灯与分区圆点）
  const configured = settingsConfigured as Record<SettingsSectionId, boolean | undefined>;

  const ensure = (): void => {
    if (built) return;
    const host = root();
    if (!host) return;
    host.innerHTML = `
      <div class="settings-accordion">
        ${SECTIONS.map(
          (id) => `
        <details class="settings-section" data-section="${id}" ${id === 'storage' ? 'open' : ''}>
          <summary>
            <span class="settings-section-title">${SECTION_TITLES[id]}</span>
            <span class="settings-dot" data-dot="${id}"></span>
          </summary>
          <div class="settings-section-body" data-body="${id}"></div>
        </details>`,
        ).join('')}
      </div>`;
    // 手风琴：同一时间只展开一个分区（点开的胜出，再点收起）
    host.querySelectorAll('.settings-section > summary').forEach((s) => {
      s.addEventListener('click', () => {
        const detail = (s.parentElement as HTMLDetailsElement);
        const wasOpen = detail.open;
        host.querySelectorAll('.settings-section').forEach((d) => ((d as HTMLDetailsElement).open = false));
        if (!wasOpen) detail.open = true;
      });
    });

    buildSectionBodies();
    bindSectionActions();
    built = true;
  };

  // ─── 分区表单（字段与原实现一致，按分区装进手风琴）──────────
  const buildSectionBodies = (): void => {
    const body = (id: SettingsSectionId): HTMLElement =>
      document.querySelector(`[data-body="${id}"]`) as HTMLElement;
    body('storage').innerHTML = `
      <form id="settings-form" class="settings-form">
        <p class="settings-hint" id="storage-hint"></p>
        <label>AccessKey<input name="access_key" autocomplete="off" /></label>
        <label>SecretKey<input name="secret_key" type="password" autocomplete="off" /></label>
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
      </form>`;
    body('llm').innerHTML = `
      <form id="llm-form" class="settings-form">
        <p class="settings-hint" id="llm-hint"></p>
        <label>Base URL<input name="llm_base_url" placeholder="https://api.deepseek.com/v1" /></label>
        <label>模型名<input name="llm_model" placeholder="deepseek-chat" /></label>
        <label>API Key<input name="llm_api_key" type="password" autocomplete="off" /></label>
        <div class="settings-ops"><button type="button" id="llm-save" class="btn-primary">保存大模型</button></div>
      </form>`;
    body('qdrant').innerHTML = `
      <form id="qdrant-form" class="settings-form">
        <p class="settings-hint">归档「同步」把分享版 Markdown 写入该 collection。使用 ptdoc-qdrant-gateway 时 URL 填网关地址。</p>
        <label>URL<input name="qdrant_url" placeholder="http://ptdoc-qdrant-gateway:8080" /></label>
        <label>Collection<input name="qdrant_collection" /></label>
        <label>Vector 名（可选）<input name="qdrant_vector" /></label>
        <label>top-k<input name="qdrant_topk" type="number" min="1" max="20" value="5" /></label>
        <label>API Key<input name="qdrant_api_key" type="password" autocomplete="off" /></label>
        <div class="settings-ops"><button type="button" id="qdrant-save" class="btn-primary">保存知识库</button></div>
      </form>`;
    body('password').innerHTML = `
      <form id="password-form" class="settings-form">
        <label>原密码<input name="old_password" type="password" autocomplete="current-password" /></label>
        <label>新密码<input name="new_password" type="password" autocomplete="new-password" /></label>
        <div class="settings-ops"><button type="button" id="password-save" class="btn-primary">更新密码</button></div>
      </form>`;
    body('token').innerHTML = `
      <form id="token-form" class="settings-form">
        <p class="settings-hint" id="api-token-hint"></p>
        <label>新 Token<input name="api_token" autocomplete="off" placeholder="16–64 位字母或数字" /></label>
        <div class="settings-ops">
          <button type="button" id="api-token-save" class="btn-primary">保存 Token</button>
          <button type="button" id="api-token-clear">清空 Token</button>
        </div>
      </form>`;
  };

  const bindSectionActions = (): void => {
    document.getElementById('storage-test')!.addEventListener('click', () => void test());
    document.getElementById('password-save')!.addEventListener('click', () => void changePassword());
    document.getElementById('llm-save')!.addEventListener('click', () => void saveLlm());
    document.getElementById('qdrant-save')!.addEventListener('click', () => void saveQdrant());
    document.getElementById('api-token-save')!.addEventListener('click', () => void saveApiToken());
    document.getElementById('api-token-clear')!.addEventListener('click', () => void clearApiToken());
    (document.getElementById('settings-form') as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      void save();
    });
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
    configured.storage = p.secret_configured && p.verified;
    refreshDots();
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
      await fill();
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
    const form = document.getElementById('llm-form') as HTMLFormElement;
    (form.elements.namedItem('llm_base_url') as HTMLInputElement).value = p.base_url;
    (form.elements.namedItem('llm_model') as HTMLInputElement).value = p.model;
    const key = form.elements.namedItem('llm_api_key') as HTMLInputElement;
    key.value = '';
    key.placeholder = p.secret_configured ? '已配置（留空则保持原值）' : '未配置';
    (document.getElementById('llm-hint') as HTMLElement).textContent = p.secret_configured ? '已保存' : '尚未配置';
    configured.llm = p.secret_configured;
    refreshDots();
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
    const form = document.getElementById('qdrant-form') as HTMLFormElement;
    (form.elements.namedItem('qdrant_url') as HTMLInputElement).value = p.url;
    (form.elements.namedItem('qdrant_collection') as HTMLInputElement).value = p.collection;
    (form.elements.namedItem('qdrant_vector') as HTMLInputElement).value = p.vector_name;
    (form.elements.namedItem('qdrant_topk') as HTMLInputElement).value = String(p.top_k || 5);
    const key = form.elements.namedItem('qdrant_api_key') as HTMLInputElement;
    key.value = '';
    key.placeholder = p.secret_configured ? '已配置（留空则保持原值）' : '可选';
    configured.qdrant = !!(p.url && p.collection);
    refreshDots();
  };

  const saveLlm = async (): Promise<void> => {
    const form = document.getElementById('llm-form') as HTMLFormElement;
    const body: Record<string, unknown> = {
      base_url: (form.elements.namedItem('llm_base_url') as HTMLInputElement).value,
      model: (form.elements.namedItem('llm_model') as HTMLInputElement).value,
    };
    const key = (form.elements.namedItem('llm_api_key') as HTMLInputElement).value.trim();
    if (key) body.api_key = key;
    // 首次配置必须有 API Key（服务端回填不到）；本地预检给出明确提示，避免裸 400
    if (!body.base_url || !body.model || (!key && !configured.llm)) {
      opts.onStatus('请填写 Base URL、模型名，首次配置还需 API Key', true);
      return;
    }
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
    const form = document.getElementById('qdrant-form') as HTMLFormElement;
    const body: Record<string, unknown> = {
      url: (form.elements.namedItem('qdrant_url') as HTMLInputElement).value,
      collection: (form.elements.namedItem('qdrant_collection') as HTMLInputElement).value,
      vector_name: (form.elements.namedItem('qdrant_vector') as HTMLInputElement).value,
      top_k: Number((form.elements.namedItem('qdrant_topk') as HTMLInputElement).value || 5),
    };
    const key = (form.elements.namedItem('qdrant_api_key') as HTMLInputElement).value.trim();
    if (key) body.api_key = key;
    if (!body.url || !body.collection) {
      opts.onStatus('请填写 Qdrant URL 与 Collection', true);
      return;
    }
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
    const form = document.getElementById('password-form') as HTMLFormElement;
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
      form.reset();
    } catch (e) {
      opts.onStatus((e as Error).message, true);
    }
  };

  const fillApiToken = async (): Promise<void> => {
    const hint = document.getElementById('api-token-hint') as HTMLElement;
    const input = (document.getElementById('token-form') as HTMLFormElement).elements.namedItem(
      'api_token',
    ) as HTMLInputElement;
    const clearBtn = document.getElementById('api-token-clear') as HTMLButtonElement;
    const res = await fetch('/api/auth/me');
    const me = (await res.json()) as { has_api_token?: boolean };
    const has = !!me.has_api_token;
    configured.token = has;
    hint.textContent = has ? '已配置（服务端不保存明文，填写新值即可轮换）' : '未配置';
    input.value = '';
    clearBtn.disabled = !has;
    refreshDots();
  };

  const saveApiToken = async (): Promise<void> => {
    const form = document.getElementById('token-form') as HTMLFormElement;
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

  /** 刷新抽屉分区 + Sider 导航的配置状态圆点（绿=已配置可用，灰=未配置） */
  const refreshDots = (): void => {
    for (const id of SECTIONS) {
      const on = !!configured[id];
      const dot = root()?.querySelector(`[data-dot="${id}"]`);
      if (dot) dot.className = 'settings-dot' + (on ? ' on' : '');
      for (const navDot of document.querySelectorAll(`[data-nav-dot="${id}"]`)) {
        navDot.className = 'settings-dot mini' + (on ? ' on' : '');
      }
    }
  };

  return {
    // 打开设置主界面并展开指定分区（Sider 配置项导航回调）
    openSection: (section: SettingsSectionId): void => {
      ensure();
      void fill().then(() => {
        const host = root()!;
        host.querySelectorAll('.settings-section').forEach((x) => ((x as HTMLDetailsElement).open = false));
        const target = host.querySelector(`.settings-section[data-section="${section}"]`) as HTMLDetailsElement | null;
        if (target) target.open = true;
        target?.scrollIntoView({ block: 'start' });
      });
    },
  };
}
