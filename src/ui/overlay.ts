// ─── 浮层统一管理（抽屉 / 模态）────────────────────────────
// 抽屉（`.drawer`）由 media / settings / admin / agent / history / share-list /
// snapshot 七处各自创建，原先是各管各的：两个永远 `right:0; z-index:40` 的抽屉
// 叠在一起，且只有历史抽屉响应 Esc。
//
// 这里集中处理两件事，各处抽屉代码一行都不用改：
//   1. 互斥：任一抽屉加上 `.open` 时，关掉其它抽屉（后开的胜出）。
//   2. Esc：关掉最上层的模态；没有模态就关最近打开的抽屉。
//
// 模态关闭走它自己的关闭按钮（`#xxx-close`），这样 publish-diff 那类
// 「await 一个 Promise」的弹窗能正常 resolve，不会留悬挂的 Promise。

let lastDrawer: HTMLElement | null = null;

/** 关掉最上层浮层（模态优先，其次抽屉）。返回是否真的关掉了东西。 */
export function closeTopOverlay(): boolean {
  const modal = document.querySelector<HTMLElement>('.modal-backdrop.open');
  if (modal) {
    const close = modal.querySelector<HTMLElement>('button[id$="-close"]');
    if (close) close.click();
    else modal.classList.remove('open');
    return true;
  }
  const open = [...document.querySelectorAll<HTMLElement>('.drawer.open')];
  const top = lastDrawer && open.includes(lastDrawer) ? lastDrawer : open[open.length - 1];
  if (!top) return false;
  top.classList.remove('open');
  lastDrawer = null;
  return true;
}

/** 挂上互斥监听（一次，登录前后都可以挂）。 */
export function initOverlayManager(): void {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (!el.classList?.contains('drawer') || !el.classList.contains('open')) continue;
      lastDrawer = el;
      for (const other of document.querySelectorAll<HTMLElement>('.drawer.open')) {
        if (other !== el) other.classList.remove('open');
      }
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
