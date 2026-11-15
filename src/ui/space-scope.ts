/**
 * 空间作用域（Space 隔离 P3/P4 共用）：当前空间、跨空间筛选下拉。
 *
 * sidebar 是当前空间的唯一写入方，切换时 dispatch `ptdoc:space-changed`；
 * 归档页与顶部全文搜索读同一个值，保证「切空间后列表跟着换」。
 */

export const SPACE_KEY = 'ptdoc.current-space';
export const SPACE_EVENT = 'ptdoc:space-changed';

export interface SpaceLite {
  id: number;
  name: string;
  is_default: 0 | 1;
}

/** 当前空间 id；未初始化（首次访问且没有默认空间）时为 null。 */
export function getCurrentSpaceId(): number | null {
  try {
    const raw = localStorage.getItem(SPACE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 供 sidebar 切换时调用：写盘 + 广播，归档页/搜索靠这个事件刷新。 */
export function publishCurrentSpace(id: number): void {
  try {
    localStorage.setItem(SPACE_KEY, String(id));
  } catch {
    /* 隐私模式：本次会话内仍靠内存变量，不写盘 */
  }
  window.dispatchEvent(new CustomEvent(SPACE_EVENT, { detail: { id } }));
}

/** 订阅空间变化；返回取消订阅函数。 */
export function onSpaceChanged(fn: (id: number) => void): () => void {
  const handler = (e: Event): void => {
    const id = (e as CustomEvent<{ id: number }>).detail?.id;
    if (typeof id === 'number') fn(id);
  };
  window.addEventListener(SPACE_EVENT, handler);
  return () => window.removeEventListener(SPACE_EVENT, handler);
}

export async function loadSpaces(): Promise<SpaceLite[]> {
  const res = await fetch('/api/spaces');
  if (!res.ok) return [];
  const data = (await res.json()) as { spaces?: SpaceLite[] };
  return data.spaces ?? [];
}

/** `?space=` 的值：'all' 表示不过滤。 */
export type SpaceScope = number | 'all';

export function readScope(select: HTMLSelectElement): SpaceScope {
  const v = select.value;
  return v === 'all' ? 'all' : Number(v);
}

export function scopeQuery(scope: SpaceScope): string {
  return scope === 'all' ? '' : `?space=${scope}`;
}

/**
 * 跨空间筛选下拉的 HTML：默认「当前空间」，可按空间名挑，也可切「全部空间」。
 * selectId 由调用方给，避免归档页与搜索框抢同一个 id。
 */
export function scopeSelectHtml(selectId: string, spaces: SpaceLite[], currentId: number | null): string {
  const cur = currentId != null ? spaces.find((s) => s.id === currentId) : undefined;
  const curLabel = cur ? cur.name : '当前空间';
  const options = [
    `<option value="${currentId ?? 'all'}" selected>当前空间${cur ? '（' + escapeAttr(cur.name) + '）' : ''}</option>`,
    `<option value="all">全部空间</option>`,
    ...spaces
      .filter((s) => s.id !== currentId)
      .map((s) => `<option value="${s.id}">${escapeAttr(s.name)}</option>`),
  ];
  if (currentId == null) options.shift();
  return `<select id="${selectId}" class="space-scope" aria-label="空间筛选" title="筛选：当前空间 / 全部空间 / 指定空间">${options.join(
    '',
  )}</select>`;
}

/** 已知当前空间名时把下拉的展示文案刷准（切空间后不用重建整个下拉）。 */
export function syncScopeLabel(select: HTMLSelectElement, spaces: SpaceLite[], currentId: number | null): void {
  const cur = currentId != null ? spaces.find((s) => s.id === currentId) : undefined;
  for (const opt of Array.from(select.options)) {
    if (opt.value === String(currentId) || (currentId == null && opt.value === 'all')) {
      opt.textContent = `当前空间${cur ? '（' + cur.name + '）' : ''}`;
      if (select.value === String(currentId)) return;
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
