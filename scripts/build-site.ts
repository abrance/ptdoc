// 静态站点发布：把 docs 表中的全部 Markdown 渲染为自包含静态站点 → dist-site/
// 运行：npm run build-site（Node 24 直接跑 TS；复用 core 的 marked / mermaid / slug）
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { initDB, listAllDocs, getDoc, getUserByUsername, getUserById } from '../src/server/db.ts';
import { renderMarkdown } from '../src/core/markdown.ts';
import { renderMermaidToSvg } from '../src/core/mermaid.ts';
import { slugify } from '../src/core/slug.ts';

const ROOT = process.cwd();
const OUT = join(ROOT, 'dist-site');
const SITE_TITLE = process.env.VITE_SITE_TITLE || 'PTDoc · 我的 Markdown 文档站';

interface SiteDoc {
  id: number;
  doc_key: string;
  title: string;
  filename: string;
  content: string;
  htmlPath: string;
}

function docKeyToHtmlPath(docKey: string): string {
  return docKey.replace(/\.md$/i, '') + '.html';
}

function deriveTitle(md: string, filename: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return (m ? m[1].trim() : filename || '未命名文档').slice(0, 120);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 给渲染后 HTML 的 h1~h3 注入稳定锚点 id（与 FR-03 TOC 共用 slug 规则）。 */
function injectHeadingIds(html: string): string {
  const seen = new Map<string, number>();
  return html.replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g, (m, level, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
    const base = slugify(text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

/** 渲染文档正文：mermaid 内联 SVG + 站内互链改写 + 标题锚点。 */
function renderBody(md: string): string {
  let html = renderMarkdown(md);
  html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_m, escaped: string) => {
    const code = decodeHtmlEntities(escaped);
    try {
      return `<div class="mermaid-render">${renderMermaidToSvg(code)}</div>`;
    } catch (e) {
      return `<div class="mermaid-error">Mermaid 渲染失败：${(e as Error).message}</div>`;
    }
  });
  html = html.replace(/href="([^"]*\.md)(#[^"]*)?"/gi, (m, path: string, anchor: string) => {
    if (/^(https?:|mailto:|#)/i.test(path)) return m;
    return `href="${path.replace(/\.md$/i, '.html')}${anchor ?? ''}"`;
  });
  return injectHeadingIds(html);
}

// ─── 导航树（doc_key 路径分层，当前页高亮）──────────────────
type NavNode = { type: 'folder'; name: string; children: NavNode[] } | { type: 'doc'; doc: SiteDoc };

function buildNavNodes(docs: SiteDoc[]): NavNode[] {
  const roots: NavNode[] = [];
  const folderMap = new Map<string, { type: 'folder'; name: string; children: NavNode[] }>();
  const getFolder = (path: string): NavNode & { children: NavNode[] } => {
    const hit = folderMap.get(path);
    if (hit) return hit;
    const node = { type: 'folder' as const, name: path.slice(path.lastIndexOf('/') + 1), children: [] };
    folderMap.set(path, node);
    const parentPath = path.lastIndexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parentPath) getFolder(parentPath).children.push(node);
    else roots.push(node);
    return node;
  };
  for (const doc of docs) {
    const segs = doc.doc_key.split('/');
    if (segs.length === 1) roots.push({ type: 'doc', doc });
    else getFolder(segs.slice(0, -1).join('/')).children.push({ type: 'doc', doc });
  }
  return roots;
}

function navNodesHtml(nodes: NavNode[], prefix: string, currentPath: string): string {
  const parts: string[] = ['<ul class="nav-root">'];
  for (const n of nodes) {
    if (n.type === 'folder') {
      parts.push(
        `<li class="nav-folder open"><div class="nav-folder-label">▾ ${n.name}</div>${navNodesHtml(n.children, prefix, currentPath)}</li>`,
      );
    } else {
      const active = n.doc.htmlPath === currentPath ? ' active' : '';
      parts.push(
        `<li class="nav-doc${active}"><a href="${prefix}${n.doc.htmlPath}">${n.doc.title}</a></li>`,
      );
    }
  }
  parts.push('</ul>');
  return parts.join('');
}

// ─── 页面模板 ─────────────────────────────────────────────
function renderPage(docs: SiteDoc[], doc: SiteDoc | null, homeContent: string, prefix: string, currentPath: string): string {
  const title = doc ? `${doc.title} · ${SITE_TITLE}` : SITE_TITLE;
  const content = doc ? renderBody(doc.content) : renderBody(homeContent);
  const nav = navNodesHtml(buildNavNodes(docs), prefix, currentPath);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="stylesheet" href="${prefix}assets/site.css" />
</head>
<body>
<div class="site-layout">
  <aside class="site-sidebar">
    <div class="site-brand">${SITE_TITLE}</div>
    <div class="site-search">
      <input id="site-search-input" type="search" placeholder="搜索文档…" autocomplete="off" />
      <div id="site-search-results" class="site-search-results"></div>
    </div>
    <nav class="site-nav">${nav}</nav>
  </aside>
  <main class="site-content">
    <article class="markdown-body">${content}</article>
  </main>
</div>
<script>window.SITE_PREFIX = ${JSON.stringify(prefix)};</script>
<script src="${prefix}assets/minisearch.min.js"></script>
<script src="${prefix}assets/site.js"></script>
</body>
</html>`;
}

/** 页面相对站点根的 "../" 前缀（支持拷贝到任意位置 / file:// 打开）。 */
function pagePrefix(htmlPath: string): string {
  const depth = htmlPath.split('/').length - 1;
  return depth > 0 ? '../'.repeat(depth) : '';
}

// ─── 站点静态资源 ─────────────────────────────────────────
const SITE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; color: #1f2328; background: #f6f8fa; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
.site-layout { display: grid; grid-template-columns: 260px 1fr; height: 100vh; }
.site-sidebar { background: #fff; border-right: 1px solid #d0d7de; display: flex; flex-direction: column; overflow: hidden; }
.site-brand { padding: 14px 16px; font-weight: 700; border-bottom: 1px solid #d0d7de; }
.site-search { padding: 10px; border-bottom: 1px solid #d0d7de; position: relative; }
.site-search input { width: 100%; padding: 7px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; }
.site-search-results { position: absolute; left: 10px; right: 10px; top: 100%; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.12); z-index: 10; display: none; }
.site-search-results:empty { display: none; }
.search-hit { display: block; padding: 8px 12px; text-decoration: none; color: #1f2328; border-bottom: 1px solid #f0f2f5; }
.search-hit:last-child { border-bottom: 0; }
.search-hit:hover { background: #f6f8fa; }
.hit-title { display: block; font-size: 13px; font-weight: 600; }
.hit-key { display: block; font-size: 11px; color: #57606a; }
.site-nav { flex: 1; overflow: auto; padding: 8px; }
.site-nav ul { list-style: none; margin: 0; padding: 0; }
.site-nav .nav-root > li > ul { margin-left: 14px; }
.nav-folder-label { padding: 4px 8px; font-size: 13px; font-weight: 600; cursor: default; user-select: none; color: #57606a; }
.nav-folder:not(.open) > ul { display: none; }
.nav-doc a { display: block; padding: 5px 10px; border-radius: 6px; color: #1f2328; text-decoration: none; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-doc a:hover { background: #f6f8fa; }
.nav-doc.active a { background: #2563eb; color: #fff; }
.site-content { overflow: auto; background: #fff; padding: 24px 32px; }
.markdown-body { max-width: 860px; margin: 0 auto; line-height: 1.7; font-size: 15px; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 { line-height: 1.3; margin-top: 1.4em; }
.markdown-body h1 { border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
.markdown-body code { background: #f6f8fa; padding: .15em .4em; border-radius: 4px; font-size: .9em; }
.markdown-body pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow: auto; }
.markdown-body pre code { background: none; padding: 0; }
.markdown-body blockquote { margin: 1em 0; padding: 0 1em; color: #57606a; border-left: 4px solid #d0d7de; }
.markdown-body table { border-collapse: collapse; width: 100%; }
.markdown-body th, .markdown-body td { border: 1px solid #d0d7de; padding: 6px 10px; }
.markdown-body img { max-width: 100%; }
.mermaid-render { display: flex; justify-content: center; margin: 1em 0; }
.mermaid-render svg { max-width: 100%; height: auto; }
.mermaid-error { color: #c0392b; background: #fdecea; border: 1px solid #f5c6cb; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
@media (max-width: 800px) { .site-layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } .site-sidebar { border-right: 0; border-bottom: 1px solid #d0d7de; } }
`;

const SITE_JS = `(function () {
  var PREFIX = window.SITE_PREFIX || '';
  var input = document.getElementById('site-search-input');
  var results = document.getElementById('site-search-results');
  if (!input || !results) return;
  var ms = null;
  fetch(PREFIX + 'index.json')
    .then(function (r) { return r.json(); })
    .then(function (docs) {
      ms = new MiniSearch({ fields: ['title', 'filename', 'content'], storeFields: ['id', 'doc_key', 'title'] });
      ms.addAll(docs);
    })
    .catch(function () {});
  input.addEventListener('input', function () {
    results.innerHTML = '';
    var q = input.value.trim();
    if (!q || !ms) { results.style.display = 'none'; return; }
    var hits = ms.search(q, { prefix: true, fuzzy: 0.2, limit: 12 });
    hits.forEach(function (h) {
      var a = document.createElement('a');
      a.href = PREFIX + h.doc_key.replace(/\\.md$/i, '.html');
      a.className = 'search-hit';
      a.innerHTML = '<span class="hit-title"></span><span class="hit-key"></span>';
      a.querySelector('.hit-title').textContent = h.title;
      a.querySelector('.hit-key').textContent = h.doc_key;
      results.appendChild(a);
    });
    results.style.display = hits.length ? 'block' : 'none';
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var first = results.querySelector('a');
      if (first) { e.preventDefault(); location.href = first.href; }
    }
    if (e.key === 'Escape') { results.style.display = 'none'; input.blur(); }
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest && !e.target.closest('.site-search')) results.style.display = 'none';
  });
})();
`;

function parseUserFlag(): number {
  const idx = process.argv.findIndex((a) => a === '--user' || a.startsWith('--user='));
  let raw = '';
  if (idx >= 0) {
    raw = process.argv[idx].startsWith('--user=')
      ? process.argv[idx].slice('--user='.length)
      : String(process.argv[idx + 1] || '');
  }
  if (!raw) {
    throw new Error('请指定 --user <id|username>，只构建该用户工作区');
  }
  const asId = Number(raw);
  if (Number.isInteger(asId) && asId > 0) {
    const u = getUserById(asId);
    if (!u) throw new Error('用户不存在：' + raw);
    return u.id;
  }
  const u = getUserByUsername(raw);
  if (!u) throw new Error('用户不存在：' + raw);
  return u.id;
}

// ─── 主流程 ─────────────────────────────────────────────
function main(): void {
  initDB();
  const userId = parseUserFlag();
  const all = listAllDocs(userId)
    .map((d) => {
      const doc = getDoc(userId, d.id);
      if (!doc) return null;
      return {
        id: d.id,
        doc_key: d.doc_key,
        title: d.title || deriveTitle(doc.content, d.filename),
        filename: d.filename,
        content: doc.content,
        htmlPath: docKeyToHtmlPath(d.doc_key),
      } as SiteDoc;
    })
    .filter((d): d is SiteDoc => d !== null);

  // 内置欢迎文档 default 不占页面/导航，仅作为无 index.md 时的首页内容
  const docs = all.filter((d) => d.doc_key !== 'default');
  const indexMd = docs.find((d) => d.doc_key === 'index.md') ?? null;
  const homeContent =
    indexMd?.content ??
    all.find((d) => d.doc_key === 'default')?.content ??
    docs[0]?.content ??
    '# 空站点\n暂无文档，去 PTDoc 编辑器里写吧。';

  // 清空重建
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'assets'), { recursive: true });

  // 每个文档页（index.md 作为首页由下面单独写，跳过避免覆盖）
  for (const d of docs) {
    if (d.htmlPath === 'index.html') continue;
    const prefix = pagePrefix(d.htmlPath);
    const outPath = join(OUT, d.htmlPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, renderPage(docs, d, homeContent, prefix, d.htmlPath), 'utf8');
  }

  // 首页（当前页标记为 index.html，导航里 index.md 高亮）
  writeFileSync(
    join(OUT, 'index.html'),
    renderPage(docs, null, homeContent, '', 'index.html'),
    'utf8',
  );

  // 资源与索引
  copyFileSync(
    join(ROOT, 'node_modules/minisearch/dist/umd/index.js'),
    join(OUT, 'assets/minisearch.min.js'),
  );
  writeFileSync(join(OUT, 'assets/site.css'), SITE_CSS, 'utf8');
  writeFileSync(join(OUT, 'assets/site.js'), SITE_JS, 'utf8');
  const indexData = docs.map((d) => ({
    id: d.id,
    doc_key: d.doc_key,
    title: d.title,
    filename: d.filename,
    content: d.content.slice(0, 5000),
  }));
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(indexData), 'utf8');

  console.log(`已生成静态站点：${docs.length} 篇文档 → ${OUT}`);
}

main();
