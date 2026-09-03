// ─── 媒体库面板（抽屉：缩略图网格 / 复制 / 插入 / 删除）────────

interface MediaRow {
  id: number;
  qiniu_key: string;
  url: string;
  filename: string;
  source: 'direct' | 'mermaid';
  size: number;
  created_at: number;
}

interface MediaPanelOptions {
  onInsert: (url: string, filename: string) => void;
  onStatus: (msg: string, isError?: boolean) => void;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function relTime(ts: number): string {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 2592000) return Math.floor(s / 86400) + ' 天前';
  return new Date(ts).toLocaleDateString();
}

export function initMediaPanel(opts: MediaPanelOptions): { toggle: () => void; refresh: () => Promise<void> } {
  let drawer: HTMLElement | null = null;

  const ensure = (): HTMLElement => {
    if (drawer && document.body.contains(drawer)) return drawer;
    drawer = document.createElement('div');
    drawer.id = 'media-drawer';
    drawer.className = 'drawer media-drawer';
    drawer.innerHTML = `
      <div class="drawer-head">
        <input id="media-search" type="search" placeholder="搜索文件名 / URL…" />
        <select id="media-source" title="按来源筛选">
          <option value="">全部来源</option>
          <option value="direct">直接上传</option>
          <option value="mermaid">mermaid 图</option>
        </select>
        <button id="media-close" type="button">✕</button>
      </div>
      <div id="media-grid" class="media-grid"></div>`;
    document.body.appendChild(drawer);
    $('media-close').addEventListener('click', () => drawer!.classList.remove('open'));
    const search = $('media-search') as HTMLInputElement;
    const source = $('media-source') as HTMLSelectElement;
    search.addEventListener('input', () => void refresh());
    source.addEventListener('change', () => void refresh());
    const grid = $('media-grid') as HTMLElement;
    grid.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
      const item = (e.target as HTMLElement).closest<HTMLElement>('.media-item');
      if (!btn || !item) return;
      const id = Number(item.dataset.id);
      const op = btn.dataset.op;
      if (op === 'copy') void copyUrl(id);
      else if (op === 'insert') insertMedia(id);
      else if (op === 'delete') void removeMedia(id);
    });
    return drawer;
  };

  const $ = (id: string) => document.getElementById(id) as HTMLElement;

  const refresh = async (): Promise<void> => {
    const grid = $('media-grid');
    if (!grid) return;
    const q = ($('media-search') as HTMLInputElement)?.value.trim() ?? '';
    const source = ($('media-source') as HTMLSelectElement)?.value ?? '';
    grid.innerHTML = '<div class="media-empty">加载中…</div>';
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (source) params.set('source', source);
      const res = await fetch('/api/media?' + params.toString());
      const rows = (await res.json()) as MediaRow[];
      grid.innerHTML = '';
      if (rows.length === 0) {
        grid.innerHTML = '<div class="media-empty">暂无图片，去上传一张吧</div>';
        return;
      }
      rows.forEach((m) => {
        const item = document.createElement('div');
        item.className = 'media-item';
        item.dataset.id = String(m.id);
        const tag = m.source === 'mermaid' ? 'mermaid' : '直接上传';
        item.innerHTML = `
          <img src="${esc(m.url)}" alt="" loading="lazy" />
          <div class="media-meta">
            <div class="media-name" title="${esc(m.filename)}">${esc(m.filename)}</div>
            <div class="media-sub">${tag} · ${relTime(m.created_at)}</div>
          </div>
          <div class="media-ops">
            <button data-op="copy" type="button">复制</button>
            <button data-op="insert" type="button">插入</button>
            <button data-op="delete" type="button">删除</button>
          </div>`;
        item.querySelector('img')!.onerror = () => {
          item.querySelector('img')!.style.opacity = '0.3';
        };
        grid.appendChild(item);
      });
    } catch {
      grid.innerHTML = '<div class="media-empty">加载失败</div>';
    }
  };

  const copyUrl = async (id: number): Promise<void> => {
    try {
      const res = await fetch('/api/media');
      const rows = (await res.json()) as MediaRow[];
      const m = rows.find((r) => r.id === id);
      if (!m) return;
      await navigator.clipboard.writeText(m.url);
      opts.onStatus('已复制：' + m.url);
    } catch (e) {
      opts.onStatus('复制失败：' + (e as Error).message, true);
    }
  };

  const insertMedia = (id: number): void => {
    // 直接在当前数据里找（refresh 已缓存行数据在 DOM dataset？重新拉一次更稳）
    void (async () => {
      const res = await fetch('/api/media');
      const rows = (await res.json()) as MediaRow[];
      const m = rows.find((r) => r.id === id);
      if (!m) return;
      opts.onInsert(m.url, m.filename);
    })();
  };

  const removeMedia = async (id: number): Promise<void> => {
    const res = await fetch('/api/media');
    const rows = (await res.json()) as MediaRow[];
    const m = rows.find((r) => r.id === id);
    if (!m) return;
    if (!confirm(`删除「${m.filename}」？\n将同时删除七牛桶内文件。已生成的分享版/站点图片会失效，需重新生成。`)) return;
    try {
      const r = await fetch(`/api/media/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || 'HTTP ' + r.status);
      }
      opts.onStatus('已删除：' + m.filename);
      void refresh();
    } catch (e) {
      opts.onStatus('删除失败：' + (e as Error).message, true);
    }
  };

  return {
    toggle: () => {
      const d = ensure();
      d.classList.toggle('open');
      if (d.classList.contains('open')) void refresh();
    },
    refresh,
  };
}
