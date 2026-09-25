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
// 原生 <dialog>（dialog.ts 的确认/输入框）走 close()，同样能 resolve。

let lastDrawer: HTMLElement | null = null;
// 打开抽屉的那个按钮，关抽屉时把焦点还回去
let drawerTrigger: HTMLElement | null = null;

/**
 * 抽屉的可访问性 + 焦点管理。
 * 七个抽屉都是「不阻塞页面」的侧栏（开着也能点编辑器、滚预览），所以只标 role=dialog +
 * aria-label，**不标 aria-modal**：标错会告诉读屏「背后内容不可用」，而这里是可用的。
 * 打开时把焦点送进第一个可聚焦元素（设置/历史/媒体都是搜索框或首个输入框），
 * 关闭时如果焦点还在抽屉里就还给触发按钮。
 */
function decorateDrawer(el: HTMLElement, trigger: HTMLElement | null): void {
  if (el.dataset.a11yReady) return;
  el.dataset.a11yReady = '1';
  el.setAttribute('role', 'dialog');
  if (!el.getAttribute('aria-label')) {
    // 优先抽屉自己的标题；没有标题的（媒体库/历史）就用触发按钮的文案（「媒体库」「历史」）
    const label = el.querySelector('.drawer-title')?.textContent?.trim() || trigger?.textContent?.trim();
    el.setAttribute('aria-label', label || '面板');
  }
}

function firstFocusable(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(
    'input:not([type=hidden]), select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])',
  );
}

/**
 * 把焦点还给触发按钮。窄屏下触发按钮可能已经被搬进收起的「更多」菜单里（display:none），
 * 对隐藏元素 focus() 是空操作，还会把焦点丢到 body；这种情况就不动焦点。
 */
function restoreFocus(trigger: HTMLElement | null): void {
  if (trigger && (trigger.offsetParent !== null || trigger === document.body)) trigger.focus();
}

/** 关掉最上层浮层（原生 dialog → 模态 → 抽屉）。返回是否真的关掉了东西。 */
export function closeTopOverlay(): boolean {
  // 原生 dialog 自带 top-layer，一定在最上面；Esc 交给它自己的 close()，
  // 否则会「对话框还开着，身后抽屉被关掉」。
  const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  if (dialogs.length > 0) {
    dialogs[dialogs.length - 1].close();
    return true;
  }
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

/** 已记录为「开着」的抽屉，用来只在状态真正翻转时处理焦点（class 变更会被反复触发）。 */
const openDrawers = new WeakSet<HTMLElement>();

/** 挂上互斥监听（一次，登录前后都可以挂）。 */
export function initOverlayManager(): void {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (!el.classList?.contains('drawer')) continue;
      const nowOpen = el.classList.contains('open');
      if (nowOpen === openDrawers.has(el)) continue;
      if (nowOpen) {
        openDrawers.add(el);
        lastDrawer = el;
        for (const other of document.querySelectorAll<HTMLElement>('.drawer.open')) {
          if (other !== el) other.classList.remove('open');
        }
        // 点开抽屉后焦点应该进去，否则键盘用户按 Tab 会跑到背后的文档树上。
        // 用「开之前谁有焦点」当触发按钮记下来，关抽屉时还给它。
        drawerTrigger = document.activeElement as HTMLElement | null;
        decorateDrawer(el, drawerTrigger);
        firstFocusable(el)?.focus();
      } else {
        openDrawers.delete(el);
        if (el.contains(document.activeElement)) restoreFocus(drawerTrigger);
      }
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
