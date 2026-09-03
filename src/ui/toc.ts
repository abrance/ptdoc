import { headingSlugs } from '../core/slug';

let activeIndex = -1;

function highlight(items: HTMLElement[], idx: number): void {
  if (idx === activeIndex) return;
  activeIndex = idx;
  items.forEach((li, i) => li.classList.toggle('active', i === idx));
}

/**
 * 扫描预览 DOM 的 h1~h3：注入稳定锚点 id，并重建目录。
 * 编辑内容变化后整树重建，slug 确定性保证锚点在重渲染后稳定。
 */
export function renderToc(preview: HTMLElement, tocEl: HTMLElement | null): void {
  const headings = [...preview.querySelectorAll<HTMLElement>('h1,h2,h3')];
  const slugs = headingSlugs(headings.map((h) => h.textContent ?? ''));
  headings.forEach((h, i) => {
    h.id = slugs[i];
    h.dataset.tocIndex = String(i);
  });
  activeIndex = -1;

  if (!tocEl) return;
  tocEl.innerHTML = '';
  if (headings.length === 0) {
    tocEl.innerHTML = '<div class="toc-empty">当前文档没有标题</div>';
    return;
  }
  const ul = document.createElement('ul');
  const items: HTMLElement[] = [];
  headings.forEach((h, i) => {
    const li = document.createElement('li');
    li.className = 'toc-item l' + h.tagName.slice(1);
    const a = document.createElement('a');
    a.href = '#' + slugs[i];
    a.textContent = h.textContent ?? '';
    a.title = a.textContent;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      highlight(items, i);
    });
    li.appendChild(a);
    ul.appendChild(li);
    items.push(li);
  });
  tocEl.appendChild(ul);
}

/**
 * 预览区滚动时高亮当前可见标题（节流到动画帧）。
 * 返回一个可移除监听器的函数。
 */
export function attachTocScrollHighlight(
  preview: HTMLElement,
  tocEl: HTMLElement | null,
): () => void {
  if (!tocEl) return () => {};
  const items = [...tocEl.querySelectorAll<HTMLElement>('.toc-item')];
  let raf = 0;
  const onScroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const headings = [...preview.querySelectorAll<HTMLElement>('h1,h2,h3')];
      const offset = preview.scrollTop + 24; // 视口顶部往下一点视为"当前"
      let idx = -1;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].offsetTop <= offset) idx = i;
        else break;
      }
      if (idx >= 0 && idx < items.length) highlight(items, idx);
      else if (idx < 0 && items.length) highlight(items, 0);
    });
  };
  preview.addEventListener('scroll', onScroll, { passive: true });
  return () => preview.removeEventListener('scroll', onScroll);
}
