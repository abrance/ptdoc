// ─── 编辑 / 预览滚动同步（分栏下双向）──────────────────────
// 思路：把两侧的「滚动比例」用标题锚点分段线性映射。
//   - 源码侧锚点：标题行号 / 总行数（跳过 ``` 围栏内的 # 行）
//   - 预览侧锚点：标题 offsetTop / 可滚动高度
// 两侧标题数量一致才映射；不一致（md 里写了裸 HTML 标题）退化为整体比例，不猜。
//
// ponytail: 源码锚点用行号估算，软换行的长段落会带几行偏差；
//          要像素级对齐得测每行高度或换 CodeMirror，先不做。

/** 把数组规整成 [0,1] 的单调不减序列，避免标题布局抖动导致回跳。 */
function normalize(xs: number[]): number[] {
  const out = xs.map((x) => Math.min(1, Math.max(0, x)));
  for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  return out;
}

/** 源码里各标题的滚动比例（1~6 级，跳过围栏代码块）。 */
export function sourceHeadingRatios(md: string): number[] {
  const lines = md.split('\n');
  const out: number[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence && /^#{1,6}\s+\S/.test(line)) out.push(lines.length > 1 ? i / (lines.length - 1) : 0);
  }
  return out;
}

/** 分段线性映射：比例 r 从 from 锚点空间搬到 to 锚点空间。 */
export function mapRatio(r: number, from: number[], to: number[]): number {
  if (from.length === 0 || from.length !== to.length) return Math.min(1, Math.max(0, r));
  let i = 0;
  while (i + 1 < from.length && from[i + 1] <= r) i++;
  const f0 = from[i];
  const f1 = from[i + 1] ?? 1;
  const t0 = to[i];
  const t1 = to[i + 1] ?? 1;
  const t = f1 > f0 ? (r - f0) / (f1 - f0) : 0;
  return t0 + Math.min(1, Math.max(0, t)) * (t1 - t0);
}

interface Options {
  /** 只在分栏视图里同步（单栏下一侧根本不可见）。 */
  isActive: () => boolean;
}

/**
 * 装上双向滚动同步，返回卸载函数。
 * 用 rAF 节流 + 120ms 方向锁防回环（程序化设 scrollTop 会再触发 scroll 事件）。
 */
export function initScrollSync(
  editor: HTMLTextAreaElement,
  preview: HTMLElement,
  opts: Options,
): () => void {
  let lock: 'editor' | 'preview' | null = null;
  let lockTimer: number | undefined;
  let raf = 0;
  let srcCacheKey = '';
  let srcCache: number[] = [];

  const ratioOf = (el: HTMLElement): number => {
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? el.scrollTop / max : 0;
  };

  const srcAnchors = (): number[] => {
    if (srcCacheKey !== editor.value || srcCache.length === 0) {
      srcCacheKey = editor.value;
      srcCache = normalize(sourceHeadingRatios(editor.value));
    }
    return srcCache;
  };

  const dstAnchors = (): number[] => {
    const max = preview.scrollHeight - preview.clientHeight;
    if (max <= 0) return [];
    const heads = preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6');
    return normalize([...heads].map((h) => h.offsetTop / max));
  };

  const apply = (from: HTMLElement, to: HTMLElement, fromAnchors: number[], toAnchors: number[]): void => {
    const max = to.scrollHeight - to.clientHeight;
    if (max <= 0) return;
    to.scrollTop = mapRatio(ratioOf(from), fromAnchors, toAnchors) * max;
  };

  const run = (dir: 'editor' | 'preview'): void => {
    if (lock === dir) return;
    if (!opts.isActive()) return;
    if (dir === 'editor') apply(editor, preview, srcAnchors(), dstAnchors());
    else apply(preview, editor, dstAnchors(), srcAnchors());
    lock = dir === 'editor' ? 'preview' : 'editor';
    clearTimeout(lockTimer);
    lockTimer = window.setTimeout(() => {
      lock = null;
    }, 120);
  };

  const onEditor = (): void => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => run('editor'));
  };
  const onPreview = (): void => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => run('preview'));
  };

  editor.addEventListener('scroll', onEditor, { passive: true });
  preview.addEventListener('scroll', onPreview, { passive: true });
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(lockTimer);
    editor.removeEventListener('scroll', onEditor);
    preview.removeEventListener('scroll', onPreview);
  };
}
