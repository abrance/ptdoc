/** 列表的「空」与「取不到」必须长得不一样（P1-4）。
 *
 * 事故形态：加载失败的提示和真·空列表用同一个 `empty` 类、同一套灰字，
 * 用户分不出「这里确实没有记录」和「请求挂了」——前者该去别处找，
 * 后者该点重试。所以错误态用独立类名 + 一个可点的重试按钮。
 */

/** `data-retry` 的值：点重试时按这个值决定重跑哪个加载函数。 */
export type RetryTarget = 'history' | 'nav-convs' | 'search-index';

export function emptyStateHtml(text: string): string {
  return `<li class="empty">${escapeHtml(text)}</li>`;
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
