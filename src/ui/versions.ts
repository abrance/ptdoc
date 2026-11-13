import { askConfirm, askText } from './dialog.ts';
import { errorStateHtml } from './list-state.ts';
import { showToast } from './toast.ts';

// ─── 版本时间线（M2-4）────────────────────────────────────
// 列表接口不含 content，预览/恢复才按 id 取全文；auto 快照只能被留存策略淘汰，不提供删除。

export type VersionKind = 'auto' | 'manual';
export type VersionFilter = 'all' | 'auto' | 'manual';

/** 列表行（GET /api/docs/:id/versions 的 items 项，无 content） */
export interface VersionItem {
  id: number;
  kind: VersionKind;
  label: string | null;
  size: number;
  sha256_short: string;
  created_at: number;
}

/** 单条详情（GET /api/docs/:id/versions/:vid），带全文 */
export interface VersionDetail {
  id: number;
  kind: VersionKind;
  label: string | null;
  content: string;
  size: number;
  sha256: string;
  created_at: number;
}

export interface RetentionSettings {
  snapshot_keep_count: number;
  snapshot_keep_days: number;
  snapshot_keep_min: number;
}

/** created_at 服务端按秒返回；旧快照接口用毫秒，两种都接住。 */
export function toMillis(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const ms = toMillis(ts);
  if (!ms) return '未知时间';
  const s = Math.floor((now - ms) / 1000);
  if (s < 0) return '刚刚';
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 2592000) return Math.floor(s / 86400) + ' 天前';
  return new Date(ms).toLocaleDateString();
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return Math.round(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
}

/** 统一成 sha256 前 7 位（服务端可能给长 sha，也可能给短 sha） */
export function shortSha(sha: string): string {
  return (sha || '').replace(/[^0-9a-f]/gi, '').slice(0, 7);
}

export function filterVersions(items: VersionItem[], filter: VersionFilter): VersionItem[] {
  return filter === 'all' ? items.slice() : items.filter((v) => v.kind === filter);
}

/** 只有手动快照能删；自动快照由留存策略淘汰 */
export function canDeleteVersion(kind: VersionKind): boolean {
  return kind === 'manual';
}

export function isVersionKind(k: unknown): k is VersionKind {
  return k === 'auto' || k === 'manual';
}

/** 列表行副标题：相对时间 · 大小 · sha 前 7 位 */
export function versionMeta(v: VersionItem, now = Date.now()): string {
  return [relativeTime(v.created_at, now), formatSize(v.size), shortSha(v.sha256_short)].join(' · ');
}

export function versionTitle(v: { label: string | null; kind: VersionKind }): string {
  const label = (v.label || '').trim();
  if (label) return label;
  return v.kind === 'auto' ? '自动快照' : '未命名快照';
}

/** doc_key 里可能带 /，裸斜杠会落到文档列表路由，必须转义 */
export function docSegment(ref: string | number): string {
  return encodeURIComponent(String(ref));
}

export function versionsUrl(ref: string | number, cursor?: number): string {
  const base = `/api/docs/${docSegment(ref)}/versions`;
  return cursor ? `${base}?limit=50&cursor=${docSegment(cursor)}` : `${base}?limit=50`;
}

export function versionUrl(ref: string | number, vid: number, suffix = ''): string {
  return `${versionsUrl(ref).split('?')[0]}/${docSegment(vid)}${suffix}`;
}

/** 留存策略校验：三项互相约束，返回人类可读的错误（空数组=通过） */
export function validateRetention(v: RetentionSettings): string[] {
  const errors: string[] = [];
  const { snapshot_keep_count: count, snapshot_keep_days: days, snapshot_keep_min: min } = v;
  if (!Number.isInteger(count) || count < 1 || count > 200) errors.push('保留条数需为 1-200 的整数');
  if (!Number.isInteger(days) || days < 1 || days > 365) errors.push('保留天数需为 1-365 的整数');
  if (!Number.isInteger(min) || min < 0) errors.push('最少保留需为非负整数');
  else if (Number.isInteger(count) && min > count) errors.push('最少保留不能大于保留条数');
  return errors;
}

export function retentionSummary(total: number, pruneEstimate: number): string {
  const prune = pruneEstimate > 0 ? `将清理 ${pruneEstimate} 条` : '不会有快照被清理';
  return `当期 ${total} 条 · ${prune}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

// ─── 抽屉 ───────────────────────────────────────────────
export interface VersionsDrawerOptions {
  /** 当前文档引用：优先数字 id，退回 doc_key（内部会 encodeURIComponent） */
  getRef: () => string | number | null;
  onStatus: (msg: string, isError?: boolean) => void;
  /** 恢复成功后把内容写回编辑器（服务端已改库，这里同步界面） */
  onRestored: (content: string) => void;
}

export function initVersionsDrawer(opts: VersionsDrawerOptions): {
  toggle: () => void;
  refresh: () => Promise<void>;
} {
  let drawer: HTMLElement | null = null;
  let items: VersionItem[] = [];
  let nextCursor: number | null = null;
  let filter: VersionFilter = 'all';
  let loading = false;

  const $ = (id: string): HTMLElement => drawer!.querySelector(`#${id}`) as HTMLElement;

  const ensure = (): HTMLElement => {
    if (drawer) return drawer;
    drawer = document.createElement('div');
    drawer.id = 'version-drawer';
    drawer.className = 'drawer';
    drawer.innerHTML = `
      <div class="drawer-head">
        <span class="drawer-title">版本时间线</span>
        <button id="version-new" type="button">保存版本</button>
        <button id="version-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="version-filter" role="tablist" aria-label="版本类型筛选">
        <button type="button" role="tab" data-filter="all" class="active" aria-selected="true">全部</button>
        <button type="button" role="tab" data-filter="auto" aria-selected="false">自动</button>
        <button type="button" role="tab" data-filter="manual" aria-selected="false">手动</button>
      </div>
      <ul id="version-list" class="history-list"></ul>`;
    document.body.appendChild(drawer);

    $('version-close').addEventListener('click', () => drawer!.classList.remove('open'));
    $('version-new').addEventListener('click', () => void saveVersion());

    drawer.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        filter = b.dataset.filter as VersionFilter;
        drawer!.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((x) => {
          const on = x === b;
          x.classList.toggle('active', on);
          x.setAttribute('aria-selected', String(on));
        });
        renderList();
      }),
    );

    $('version-list').addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      if (el.closest('[data-more]')) {
        void loadMore();
        return;
      }
      if (el.closest('[data-retry]')) {
        void load(false);
        return;
      }
      const btn = el.closest<HTMLElement>('button[data-op]');
      const li = el.closest<HTMLElement>('.snapshot-item');
      if (!btn || !li) return;
      const v = items.find((x) => String(x.id) === li.dataset.vid);
      if (!v) return;
      const op = btn.dataset.op;
      if (op === 'preview') void previewVersion(v);
      else if (op === 'restore') void restoreVersion(v);
      else if (op === 'delete') void deleteVersion(v);
    });
    return drawer;
  };

  const renderList = (): void => {
    const list = $('version-list');
    const visible = filterVersions(items, filter);
    list.innerHTML = '';
    if (items.length === 0) {
      list.innerHTML = '<li class="empty">暂无版本，点「保存版本」记录当前内容</li>';
      return;
    }
    if (visible.length === 0) {
      list.innerHTML = `<li class="empty">没有${filter === 'auto' ? '自动' : '手动'}快照</li>`;
      return;
    }
    for (const v of visible) {
      const li = document.createElement('li');
      li.className = 'snapshot-item';
      li.dataset.vid = String(v.id);
      const deletable = canDeleteVersion(v.kind);
      li.innerHTML = `
        <div class="version-row">
          <span class="snap-label">${esc(versionTitle(v))}</span>
          <span class="version-badge kind-${v.kind}">${v.kind === 'auto' ? '自动' : '手动'}</span>
        </div>
        <div class="hi-meta">${esc(versionMeta(v))}</div>
        <div class="snap-ops">
          <button data-op="preview" type="button">预览</button>
          <button data-op="restore" type="button">回滚</button>
          <button data-op="delete" type="button" ${deletable ? '' : 'disabled title="自动快照由留存策略淘汰"'}>删除</button>
        </div>`;
      list.appendChild(li);
    }
    if (nextCursor != null) {
      const more = document.createElement('li');
      more.className = 'version-more';
      more.innerHTML = '<button data-more type="button">加载更多</button>';
      list.appendChild(more);
    }
  };

  const applyPage = (payload: {
    items: VersionItem[];
    next_cursor: number | null;
  }, append: boolean): void => {
    items = append ? items.concat(payload.items) : payload.items;
    nextCursor = payload.next_cursor ?? null;
    renderList();
  };

  const load = async (append: boolean): Promise<void> => {
    const ref = opts.getRef();
    if (ref == null) {
      items = [];
      nextCursor = null;
      ensure();
      $('version-list').innerHTML = '<li class="empty">请先保存或打开一篇文档</li>';
      return;
    }
    if (loading) return;
    loading = true;
    try {
      const cursor = append && nextCursor != null ? nextCursor : undefined;
      const res = await fetch(versionsUrl(ref, cursor));
      const body = (await res.json().catch(() => ({}))) as {
        items?: VersionItem[];
        next_cursor?: number | null;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      const clean = (body.items || []).filter((v) => v && isVersionKind(v.kind));
      applyPage({ items: clean, next_cursor: body.next_cursor ?? null }, append);
    } catch (e) {
      ensure();
      // 500 以前只印一行「加载失败」，点不回去；按钮的回调挂在 #version-list 上（见上面的事件委托）。
      $('version-list').innerHTML = errorStateHtml('版本列表加载失败：' + (e as Error).message, 'versions');
    } finally {
      loading = false;
    }
  };

  const loadMore = async (): Promise<void> => {
    await load(true);
  };

  const saveVersion = async (): Promise<void> => {
    const ref = opts.getRef();
    if (ref == null) {
      opts.onStatus('请先保存或打开一篇文档', true);
      return;
    }
    const label = await askText({
      title: '保存版本',
      label: '版本说明（可留空）',
      value: '',
      confirmLabel: '保存',
    });
    if (label === null) return;
    try {
      const tag = label.trim();
      const res = await fetch(versionsUrl(ref).split('?')[0], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tag ? { label: tag } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      opts.onStatus('已保存版本' + (tag ? '：' + tag : ''));
      await load(false);
    } catch (e) {
      opts.onStatus('保存版本失败：' + (e as Error).message, true);
    }
  };

  const fetchDetail = async (ref: string | number, vid: number): Promise<VersionDetail> => {
    const res = await fetch(versionUrl(ref, vid));
    const body = (await res.json().catch(() => ({}))) as VersionDetail & { error?: string };
    if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
    return body;
  };

  const previewVersion = async (v: VersionItem): Promise<void> => {
    const ref = opts.getRef();
    if (ref == null) return;
    try {
      const detail = await fetchDetail(ref, v.id);
      openPreview(detail);
    } catch (e) {
      opts.onStatus('预览失败：' + (e as Error).message, true);
    }
  };

  const openPreview = (detail: VersionDetail): void => {
    let modal = document.getElementById('version-preview-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'version-preview-modal';
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal">
          <div class="modal-head">
            <span id="version-preview-title">版本预览（只读）</span>
            <button id="version-preview-close" type="button" aria-label="关闭">✕</button>
          </div>
          <p id="version-preview-meta" class="hi-meta version-preview-meta"></p>
          <textarea id="version-preview-text" readonly spellcheck="false"></textarea>
          <div class="modal-foot">
            <button id="version-preview-restore" type="button" class="btn-primary">回滚到此版本</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal!.remove();
      });
      document.getElementById('version-preview-close')!.addEventListener('click', () => modal!.remove());
    }
    (document.getElementById('version-preview-title') as HTMLElement).textContent =
      '版本预览（只读）：' + versionTitle(detail);
    (document.getElementById('version-preview-meta') as HTMLElement).textContent =
      `${detail.kind === 'auto' ? '自动' : '手动'} · ${relativeTime(detail.created_at)} · ${formatSize(detail.size)} · ${shortSha(detail.sha256)}`;
    (document.getElementById('version-preview-text') as HTMLTextAreaElement).value = detail.content;
    const btn = document.getElementById('version-preview-restore') as HTMLButtonElement;
    btn.onclick = () => {
      modal!.remove();
      void restoreVersion(detail);
    };
    modal.classList.add('open');
  };

  const restoreVersion = async (v: { id: number; kind: VersionKind; label: string | null }): Promise<void> => {
    const ref = opts.getRef();
    if (ref == null) return;
    const ok = await askConfirm('将用该版本覆盖当前内容；恢复前会自动生成一个「恢复前」版本。', {
      title: `回滚到「${versionTitle(v)}」？`,
      confirmLabel: '回滚',
    });
    if (!ok) return;
    try {
      // 先取全文，恢复接口只回 pre_restore_version_id，不重复读文档
      const detail = await fetchDetail(ref, v.id);
      const res = await fetch(versionUrl(ref, v.id, '/restore'), { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      opts.onRestored(detail.content);
      opts.onStatus('已回滚到：' + versionTitle(v));
      await load(false);
    } catch (e) {
      opts.onStatus('回滚失败：' + (e as Error).message, true);
    }
  };

  const deleteVersion = async (v: VersionItem): Promise<void> => {
    const ref = opts.getRef();
    if (ref == null || !canDeleteVersion(v.kind)) return;
    const ok = await askConfirm('不影响当前文档内容。', {
      title: `删除「${versionTitle(v)}」？`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(versionUrl(ref, v.id), { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      showToast('已删除版本：' + versionTitle(v), 'success');
      await load(false);
    } catch (e) {
      opts.onStatus('删除版本失败：' + (e as Error).message, true);
    }
  };

  return {
    toggle: (): void => {
      const el = ensure();
      el.classList.toggle('open');
      if (el.classList.contains('open')) {
        filter = 'all';
        el.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((x) => {
          const on = x.dataset.filter === 'all';
          x.classList.toggle('active', on);
          x.setAttribute('aria-selected', String(on));
        });
        void load(false);
      }
    },
    refresh: (): Promise<void> => load(false),
  };
}
