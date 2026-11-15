import { renderMarkdown } from './markdown.ts';

/** 目录项：h2/h3 才有 id，且 id 由本函数的 slug 生成，与 TOC 一一对应。 */
export interface TocEntry {
  level: 2 | 3;
  id: string;
  text: string;
}

/** 稳定 slug：保留中英文与数字，其余折叠为 -。中文标题必须能被 encodeURI 安全引用。 */
function slugify(raw: string, used: Set<string>): string {
  const base =
    raw
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'section';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

const HEADING_RE = /<h([23])>([\s\S]*?)<\/h\1>/g;
const HTML_TAG_RE = /<[^>]+>/g;

/**
 * 给 h2/h3 注入 id，并收集目录。只处理 renderMarkdown 产出的裸标题（marked 不生成 id）。
 * 标题里的行内 HTML（如 code）剥掉后再做 TOC 文本，slug 用同一份纯文本。
 */
export function injectHeadingIds(body: string): { body: string; toc: TocEntry[] } {
  const used = new Set<string>();
  const toc: TocEntry[] = [];
  const withIds = body.replace(HEADING_RE, (full, lv: string, inner: string) => {
    const text = inner.replace(HTML_TAG_RE, '').trim();
    const id = slugify(text, used);
    toc.push({ level: Number(lv) as 2 | 3, id, text });
    return `<h${lv} id="${id}">${inner}</h${lv}>`;
  });
  return { body: withIds, toc };
}

function tocHtml(toc: TocEntry[]): string {
  if (toc.length === 0) return '';
  const items = toc
    .map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`)
    .join('');
  // 窄屏折叠：checkbox 是唯一不依赖脚本的开关（归档页必须自包含、禁用外链与 CSP 风险）。
  return `<input type="checkbox" id="toc-toggle" hidden />
<label class="toc-btn" for="toc-toggle" aria-label="目录">目录</label>
<nav class="toc" aria-label="目录"><ul>${items}</ul></nav>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把 Markdown 渲染为自包含 HTML 文档（排版样式内联，图片为远程 URL）。
 * 前后端共用：归档产物、/a/:token、/s/:id 都用这一份，任何外部资源请求都会破坏自包含。
 */
export function buildShareHtmlDoc(md: string, title = '分享文档'): string {
  const rendered = renderMarkdown(md);
  const { body, toc } = injectHeadingIds(rendered);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fff; --fg: #1f2328; --muted: #57606a;
    --line: #d0d7de; --code-bg: #f6f8fa; --accent: #0969da;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #30363d; --code-bg: #161b22; --accent: #4493f8; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.7; }
  .markdown-body { max-width: 860px; margin: 0 auto; padding: 24px 20px; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 { line-height: 1.3; margin-top: 1.4em; scroll-margin-top: 16px; }
  .markdown-body h1 { border-bottom: 1px solid var(--line); padding-bottom: .3em; }
  .markdown-body a { color: var(--accent); }
  .markdown-body code { background: var(--code-bg); padding: .15em .4em; border-radius: 4px; font-size: .9em; }
  .markdown-body pre { background: var(--code-bg); padding: 12px 14px; border-radius: 8px; overflow: auto; }
  .markdown-body pre code { background: none; padding: 0; }
  .markdown-body blockquote { margin: 1em 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--line); }
  .markdown-body table { border-collapse: collapse; width: 100%; }
  .markdown-body th, .markdown-body td { border: 1px solid var(--line); padding: 6px 10px; }
  .markdown-body img { max-width: 100%; }

  /* TOC：宽屏常驻右侧，窄屏（<=900px）折叠成一个按钮，靠 checkbox 开关，不依赖脚本。 */
  .toc { position: fixed; top: 24px; right: 24px; width: 220px; max-height: 70vh; overflow: auto;
         font-size: 13px; line-height: 1.5; border-left: 1px solid var(--line); padding-left: 12px; }
  .toc ul { list-style: none; margin: 0; padding: 0; }
  .toc a { color: var(--muted); text-decoration: none; display: block; padding: 2px 0; }
  .toc a:hover { color: var(--accent); }
  .toc-l3 a { padding-left: 12px; font-size: 12px; }
  .toc-btn { display: none; }
  #toc-toggle { display: none; }
  @media (max-width: 900px) {
    .markdown-body { max-width: none; }
    .toc { display: none; position: static; width: auto; max-height: none; margin: 0 20px 16px;
           border-left: none; padding-left: 0; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
    .toc-btn { display: inline-block; position: fixed; top: 12px; right: 12px; z-index: 10;
               background: var(--code-bg); color: var(--fg); border: 1px solid var(--line);
               border-radius: 6px; padding: 4px 10px; font-size: 13px; }
    #toc-toggle:checked ~ .toc { display: block; }
  }
</style>
</head>
<body>
${tocHtml(toc)}
<article class="markdown-body">${body}</article>
</body>
</html>`;
}
