/** 列表的「空」与「取不到」必须长得不一样（P1-4）。
 *
 * 事故形态：加载失败的提示和真·空列表用同一个 `empty` 类、同一套灰字，
 * 用户分不出「这里确实没有记录」和「请求挂了」——前者该去别处找，
 * 后者该点重试。所以错误态用独立类名 + 一个可点的重试按钮。
 *
 * P1-7 补齐另一半：空态本身也有四种密度（一行提示 / 列表区 / 整块面板 /
 * 带引导的空页），以前是四处各写一份 padding，同一件事看起来像四件事。
 */

/** `data-retry` 的值：点重试时按这个值决定重跑哪个加载函数。 */
export type RetryTarget = 'history' | 'nav-convs' | 'search-index' | 'versions';

/** 空态密度。数值只影响留白，文案由调用方给：
 *  - inline：列表里的一行（快照面板的类型筛选、侧栏树）
 *  - list：列表区整块（历史/会话/搜索无结果）
 *  - panel：抽屉或面板的中心（媒体库）
 *  - hero：整页空（归档列表，带一个可点的下一步）
 */
export type EmptyDensity = 'inline' | 'list' | 'panel' | 'hero';

export function emptyStateHtml(text: string, density: EmptyDensity = 'list', actionHtml = ''): string {
  const cls = density === 'list' ? 'empty' : `empty empty-${density}`;
  return `<li class="${cls}">${escapeHtml(text)}${actionHtml}</li>`;
}

/** 供非 `<li>` 容器（div 网格、树）复用同一套密度与样式。 */
export function emptyStateBlockHtml(text: string, density: EmptyDensity = 'panel', actionHtml = ''): string {
  return `<div class="empty empty-${density}">${escapeHtml(text)}${actionHtml}</div>`;
}

export function errorStateHtml(text: string, retry: RetryTarget): string {
  return (
    `<li class="load-error" role="alert">` +
    `<span class="load-error-text">${escapeHtml(text)}</span>` +
    `<button type="button" class="load-retry" data-retry="${retry}">重试</button>` +
    `</li>`
  );
}

/** 与 app.ts 里同名函数一致：列表内容来自接口/索引，一律转义后再拼进 HTML。 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}
