// ─── 媒体库（主区域页面：缩略图网格 / 复制 / 插入 / 删除）────────
// 从原来的右侧抽屉改为归档 Tab 下的主区域子页，与「归档产物」并列。
import { askConfirm } from './dialog';
import { emptyStateBlockHtml } from './list-state';

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

/** 媒体库主区域页：DOM 由 index.html 提供（#media-search / #media-source / #media-grid）。 */
export function initMediaPanel(opts: MediaPanelOptions): { refresh: () => Promise<void> } {
  const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

  const search = () => $('media-search') as HTMLInputElement | null;
  const source = () => $('media-source') as HTMLSelectElement | null;
  const grid = () => $('media-grid') as HTMLElement | null;

  const fetchRows = async (withFilter = true): Promise<MediaRow[]> => {
    const params = new URLSearchParams();
    if (withFilter) {
      const q = search()?.value.trim() ?? '';
      const s = source()?.value ?? '';
      if (q) params.set('q', q);
      if (s) params.set('source', s);
    }
    const res = await fetch('/api/media?' + params.toString());
    return (await res.json()) as MediaRow[];
  };

  const refresh = async (): Promise<void> => {
    const el = grid();
    if (!el) return;
    const q = search()?.value.trim() ?? '';
    const s = source()?.value ?? '';
    el.innerHTML = '<div class="media-empty">加载中…</div>';
    try {
      const rows = await fetchRows();
      el.innerHTML = '';
      if (rows.length === 0) {
        el.innerHTML = emptyStateBlockHtml(
          q || s ? '没有匹配的图片，换个关键词或来源试试' : '暂无图片，在文档页用「上传图片」加一张',
          'panel',
        );
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
        el.appendChild(item);
      });
    } catch {
      el.innerHTML = '<div class="media-empty">加载失败</div>';
    }
  };

  const copyUrl = async (id: number): Promise<void> => {
    try {
      const rows = await fetchRows(false);
      const m = rows.find((r) => r.id === id);
      if (!m) return;
      await navigator.clipboard.writeText(m.url);
      opts.onStatus('已复制：' + m.url);
    } catch (e) {
      opts.onStatus('复制失败：' + (e as Error).message, true);
    }
  };

  const insertMedia = async (id: number): Promise<void> => {
    const rows = await fetchRows(false);
    const m = rows.find((r) => r.id === id);
    if (!m) return;
    opts.onInsert(m.url, m.filename);
  };

  const removeMedia = async (id: number): Promise<void> => {
    const rows = await fetchRows(false);
    const m = rows.find((r) => r.id === id);
    if (!m) return;
    const ok = await askConfirm('将同时删除七牛桶内文件。已生成的分享版/站点图片会失效，需重新生成。', {
      title: `删除「${m.filename}」？`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
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

  const g = grid();
  search()?.addEventListener('input', () => void refresh());
  source()?.addEventListener('change', () => void refresh());
  g?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
    const item = (e.target as HTMLElement).closest<HTMLElement>('.media-item');
    if (!btn || !item) return;
    const id = Number(item.dataset.id);
    const op = btn.dataset.op;
    if (op === 'copy') void copyUrl(id);
    else if (op === 'insert') void insertMedia(id);
    else if (op === 'delete') void removeMedia(id);
  });

  return { refresh };
}
