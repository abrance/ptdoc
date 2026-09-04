import { siteConfig } from '../config';
import { renderMarkdown } from '../core/markdown';
import { renderMermaidBlocks, renderMermaidToPngBlob, sha256Mermaid } from '../core/mermaid';
import { buildShareHtmlDoc } from '../core/share-html';
import { diffPublish, type PublishBaseline, type PublishDiff } from '../core/publish-check';
import MiniSearch from 'minisearch';
import { saveHandle, getHandle, setHandleUser } from './fileHandles';
import { renderToc, attachTocScrollHighlight } from './toc';
import { initSidebar } from './sidebar';
import { initMediaPanel } from './media';
import { startGate, logout, type SessionUser } from './gate';
import { initSettingsPanel } from './settings';
import { initAdminPanel } from './admin';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const editor = $('editor') as HTMLTextAreaElement;
const preview = $('preview') as HTMLElement;
const brand = $('brand') as HTMLElement;
const statusEl = $('status') as HTMLElement;
const mdInput = $('md-input') as HTMLInputElement;
const imgInput = $('img-input') as HTMLInputElement;

brand.textContent = siteConfig.title;
document.title = siteConfig.title;

// 当前文档标识（Web 无法按本地路径重开文件，故以 doc_key 作为"重开"主键）
let currentDocKey = 'default';
let currentFilename = 'index.md';
let renderTimer: number | undefined;
let saveTimer: number | undefined;
// 当前分享弹窗对应的 shares 记录 id（上传 HTML 成功后回写 html_url 用）
let currentShareId: number | null = null;
// 发布一致性检查：当前文档最近一次发布的基准 + 最近一次对比结果
let publishBaseline: PublishBaseline | null = null;
let lastPublishDiff: PublishDiff | null = null;
let publishCheckSeq = 0;
let publishCheckTimer: number | undefined;
// 当前文档内容来源（历史打开时区分磁盘实时读取 / 数据库快照回退）
type DocSourceKind = 'disk' | 'snapshot' | 'default';
let currentDocSource: { kind: DocSourceKind; label: string; reason: string } | null = null;
// 侧边栏文档树实例（打开/重命名后刷新高亮）
let sidebarRef: { refresh: () => Promise<void> } | null = null;
// 当前文档在 docs 表中的 id（快照等按 id 的操作依赖；随自动保存更新）
let currentDocId: number | null = null;

// ─── 渲染 ───────────────────────────────────────────────
let tocScrollCleanup: (() => void) | null = null;

function render(): void {
  preview.innerHTML = renderMarkdown(editor.value);
  renderMermaidBlocks(preview);
  bindInternalLinks();
  // 目录面板开着时：注入锚点 + 重建目录 + 重挂滚动高亮
  if (tocScrollCleanup) {
    tocScrollCleanup();
    tocScrollCleanup = null;
  }
  const panel = tocOpen ? ensureTocPanel() : null;
  if (panel) {
    const body = panel.querySelector('.toc-body') as HTMLElement;
    renderToc(preview, body);
    tocScrollCleanup = attachTocScrollHighlight(preview, body);
  }
}
function scheduleRender(): void {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, 200);
}
function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (isError ? ' error' : '');
}

/** 更新顶栏的当前文档内容来源标记（标签 + 悬停原因）。 */
function setDocSource(kind: DocSourceKind, label: string, reason: string): void {
  currentDocSource = { kind, label, reason };
  const el = $('doc-source');
  el.hidden = false;
  el.className = 'doc-source kind-' + kind;
  el.textContent = label;
  el.title = reason;
}

// ─── 预览区目录 TOC ─────────────────────────────────────
let tocOpen = false;
let tocPanel: HTMLElement | null = null;

function ensureTocPanel(): HTMLElement {
  if (tocPanel && document.body.contains(tocPanel)) return tocPanel;
  tocPanel = document.createElement('div');
  tocPanel.id = 'toc-panel';
  tocPanel.className = 'toc-panel';
  tocPanel.innerHTML =
    '<div class="toc-head"><span>目录</span><button id="toc-close" type="button">✕</button></div>' +
    '<nav class="toc-body"></nav>';
  document.body.appendChild(tocPanel);
  $('toc-close').addEventListener('click', () => toggleToc(false));
  return tocPanel;
}

function toggleToc(force?: boolean): void {
  tocOpen = force ?? !tocOpen;
  const panel = ensureTocPanel();
  panel.classList.toggle('open', tocOpen);
  document.body.classList.toggle('toc-on', tocOpen);
  if (tocOpen) render();
  else setStatus('');
}
function insertAtCursor(text: string): void {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
  editor.selectionStart = editor.selectionEnd = start + text.length;
  editor.focus();
}

// ─── 文档保存（写入历史 / 可搜索）─────────────────────────
function deriveTitle(md: string, filename: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return (m ? m[1].trim() : filename || '未命名文档').slice(0, 120);
}
async function saveCurrentDoc(): Promise<void> {
  try {
    const res = await fetch('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc_key: currentDocKey,
        title: deriveTitle(editor.value, currentFilename),
        filename: currentFilename,
        content: editor.value,
      }),
    });
    const r = (await res.json()) as { id: number };
    currentDocId = r.id;
  } catch {
    /* 离线时静默忽略 */
  }
}
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveCurrentDoc, 800);
}

// ─── 上传进度条 ─────────────────────────────────────────
const progressEl = $('progress');
const progressBar = $('progress-bar') as HTMLElement;
function setProgress(frac: number | null): void {
  if (frac === null) {
    progressEl.classList.remove('active');
    return;
  }
  progressEl.classList.add('active');
  progressBar.style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
}

// ─── 上传二进制到七牛（图床，密钥不出服务端）──────────────
// 用 XHR 以便拿到上传字节进度（onProgress: 0~1），驱动进度条。
// source: 媒体库来源标记（direct / mermaid / share），经 X-Source 头传给服务端落库；
//         其中 share 是分享版 .md/.html 产物，不写入媒体库。
function uploadBinary(
  buf: ArrayBuffer,
  filename: string,
  onProgress?: (frac: number) => void,
  keyPrefix?: string,
  source?: 'direct' | 'mermaid' | 'share',
): Promise<{ url: string; key: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(filename));
    if (keyPrefix) xhr.setRequestHeader('X-Key-Prefix', keyPrefix);
    if (source) xhr.setRequestHeader('X-Source', source);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && !data.error) resolve(data);
      else reject(new Error(data.error || 'HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('上传网络错误'));
    xhr.send(buf);
  });
}

// ─── 默认文档 / 打开本地 .md ─────────────────────────────
async function loadDefaultDoc(): Promise<void> {
  try {
    const res = await fetch(siteConfig.defaultDoc);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    editor.value = await res.text();
    currentDocKey = 'default';
    currentFilename = 'index.md';
    setDocSource('default', '默认文档', '内置示例文档（非本地文件），不参与磁盘同步');
    render();
    saveCurrentDoc();
    void refreshPublishBaseline();
  } catch (e) {
    setStatus('未能加载默认文档：' + (e as Error).message, true);
  }
}

$('open-md').addEventListener('click', openFilePicker);

// 优先用 File System Access API 打开，拿到可持久化的文件句柄，
// 下次从历史/最近里点开即可直接读真实文件，无需再选路径。
async function openFilePicker(): Promise<void> {
  const picker = (window as any).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const handles = await picker({
        multiple: false,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
      });
      const handle = handles[0];
      const file = await handle.getFile();
      const content = await file.text();
      const name = handle.name as string;
      await saveHandle(name, name, handle);
      setDocSource('disk', '磁盘实时', '通过系统文件选择器打开并已保存文件句柄，下次从历史打开会自动重读磁盘最新内容');
      loadContent(name, name, content);
      setStatus('已打开（磁盘实时）：' + name);
      return;
    } catch (e) {
      // 用户取消选择（AbortError）则什么都不做；其他异常回退到传统文件框
      if ((e as any)?.name === 'AbortError') return;
    }
  }
  // 不支持 File System Access API 时，回退到 <input type=file>
  mdInput.click();
}

mdInput.addEventListener('change', async () => {
  const file = mdInput.files?.[0];
  if (!file) return;
  setDocSource('disk', '磁盘文件', '本次选择的文件内容；未保存持久文件句柄，下次从历史打开时将读取数据库快照');
  loadContent(file.name, file.name, await file.text());
  mdInput.value = '';
});

/** 统一把文档内容载入编辑器并落库（同时更新"最近打开"时间）。 */
function loadContent(docKey: string, filename: string, content: string): void {
  editor.value = content;
  currentDocKey = docKey;
  currentFilename = filename;
  render();
  saveCurrentDoc();
  sidebarRef?.refresh();
  void refreshPublishBaseline();
}

// ─── 上传图片到七牛图床 ─────────────────────────────────
$('upload-img').addEventListener('click', () => imgInput.click());
imgInput.addEventListener('change', async () => {
  const file = imgInput.files?.[0];
  if (!file) return;
  await uploadImage(file);
  imgInput.value = '';
});
async function uploadImage(file: File): Promise<void> {
  setStatus('上传中…');
  setProgress(0);
  try {
    const data = await uploadBinary(await file.arrayBuffer(), file.name, setProgress);
    setProgress(1);
    insertAtCursor(`\n![${file.name}](${data.url})\n`);
    setStatus('已上传：' + data.url);
    render();
  } catch (e) {
    setStatus('上传失败：' + (e as Error).message, true);
  } finally {
    setTimeout(() => setProgress(null), 400);
  }
}

// ─── 发布一致性检查（当前文档 vs 最近一次发布）────────
// 打开/切换文档时拉取基准；编辑时防抖重算；结果以「生成分享版」按钮角标呈现。
async function refreshPublishBaseline(): Promise<void> {
  const seq = ++publishCheckSeq;
  clearTimeout(publishCheckTimer);
  publishBaseline = null;
  lastPublishDiff = null;
  updatePublishBadge();
  if (!currentDocKey) return;
  try {
    const res = await fetch('/api/share?doc_key=' + encodeURIComponent(currentDocKey));
    const rows = (await res.json()) as Array<{ id: number }>;
    if (seq !== publishCheckSeq) return;
    if (rows.length === 0) return; // 该文档从未发布过：无基准，不提示
    const detail = (await (await fetch('/api/share/' + rows[0].id)).json()) as {
      share_md: string;
      images: Array<{ url: string; mermaid_hash: string | null }>;
    };
    if (seq !== publishCheckSeq) return;
    publishBaseline = { share_md: detail.share_md, images: detail.images ?? [] };
    await runPublishCheck();
  } catch {
    /* 离线等场景静默忽略 */
  }
}

async function runPublishCheck(): Promise<void> {
  const seq = publishCheckSeq;
  const base = publishBaseline;
  clearTimeout(publishCheckTimer);
  const diff = await diffPublish(editor.value, base);
  if (seq !== publishCheckSeq || base !== publishBaseline) return; // 基准已变化，丢弃旧结果
  lastPublishDiff = diff;
  updatePublishBadge(diff);
}

function schedulePublishCheck(): void {
  clearTimeout(publishCheckTimer);
  publishCheckTimer = window.setTimeout(() => void runPublishCheck(), 1000);
}

function updatePublishBadge(diff?: PublishDiff | null): void {
  const badge = $('share-badge');
  if (!diff || !diff.hasBaseline || diff.consistent) {
    badge.hidden = true;
    badge.textContent = '';
    return;
  }
  const changed = diff.diagrams.filter((d) => d.status !== 'same').length + diff.removed.length;
  const n = diff.textChanges + changed;
  badge.hidden = false;
  badge.textContent = String(n);
  badge.title = `与上次发布不一致：文字改动 ${diff.textChanges} 处、图表变更 ${changed} 个`;
}

/** 展示"与上次发布不一致"的差异摘要弹窗；confirmLabel 提供时显示确认按钮（生成前确认用）。 */
function showPublishDiffModal(diff: PublishDiff, confirmLabel?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop open';
    const items: string[] = [];
    if (diff.textChanges > 0) items.push(`<li>文字改动 ${diff.textChanges} 处</li>`);
    for (const d of diff.diagrams) {
      if (d.status === 'modified') items.push(`<li class="modified">第 ${d.index} 个图表：内容已修改</li>`);
      else if (d.status === 'added') items.push(`<li class="added">新增了第 ${d.index} 个图表</li>`);
    }
    for (const idx of diff.removed) items.push(`<li class="removed">删除了发布版中的第 ${idx} 个图表</li>`);
    const listHtml =
      items.length > 0
        ? `<ul>${items.join('')}</ul>`
        : '<p>细节无法逐项比对（如渲染主题版本已升级），重新生成一次分享版即可覆盖。</p>';
    const foot = confirmLabel
      ? `<button id="pd-cancel" type="button">取消</button><button id="pd-confirm" type="button">${confirmLabel}</button>`
      : `<button id="pd-close" type="button">知道了</button>`;
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-head"><span>与上次发布不一致</span></div>
        <div class="pd-body">${listHtml}</div>
        <div class="modal-foot">${foot}</div>
      </div>`;
    document.body.appendChild(modal);
    const done = (ok: boolean): void => {
      modal.remove();
      resolve(ok);
    };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) done(false);
    });
    $('pd-cancel')?.addEventListener('click', () => done(false));
    $('pd-close')?.addEventListener('click', () => done(false));
    $('pd-confirm')?.addEventListener('click', () => done(true));
  });
}

// ─── 生成分享版（mermaid -> PNG -> 七牛 -> 远程图片 md）──
$('share-badge').addEventListener('click', (e) => {
  e.stopPropagation();
  if (lastPublishDiff && !lastPublishDiff.consistent) void showPublishDiffModal(lastPublishDiff);
});
$('share').addEventListener('click', () => void onGenerateShareClick());

/** 点「生成分享版」：若存在未发布的改动，先弹差异确认；一致则直接生成。 */
async function onGenerateShareClick(): Promise<void> {
  const diff = lastPublishDiff;
  if (diff && diff.hasBaseline && !diff.consistent) {
    const proceed = await showPublishDiffModal(diff, '继续生成');
    if (!proceed) return;
  }
  await generateShare();
}
async function generateShare(): Promise<void> {
  const md = editor.value;
  const fenceRe = /```mermaid\s*\n([\s\S]*?)```/g;
  const matches = [...md.matchAll(fenceRe)];
  if (matches.length === 0) {
    setStatus('没有找到 mermaid 代码块，无需转换');
    return;
  }
  setStatus(`正在转换 ${matches.length} 个图表为图片并上传…`);

  const images: Array<{ qiniu_key: string; url: string; mermaid_hash: string }> = [];
  let result = '';
  let last = 0;
  let i = 0;
  const total = matches.length;
  let done = 0;
  setProgress(0);
  // 分享版 .md / .html 在七牛上的落地 URL（随记录入库，供分享记录查看）
  let mdUrl = '';
  let htmlUrl = '';

  // 拉取 mermaid 内容 -> 已上传图片 的缓存，相同内容直接复用，避免重复生成/上传
  const cache = (await fetch('/api/mermaid-cache').then((r) => r.json())) as Record<string, string>;
  let cacheHits = 0;

  try {
    for (const m of matches) {
      const full = m[0];
      const start = m.index ?? 0;
      result += md.slice(last, start);
      const code = m[1];
      const hash = await sha256Mermaid(code);

      // 命中缓存：复用已上传图片，跳过渲染与上传
      if (cache[hash]) {
        cacheHits++;
        setStatus(`生成分享版：复用第 ${i + 1}/${total} 张（已存在）`);
        images.push({ qiniu_key: '', url: cache[hash], mermaid_hash: hash });
        result += `![图 ${i + 1}](${cache[hash]})\n`;
        last = start + full.length;
        done++;
        setProgress(done / total);
        i++;
        continue;
      }

      setStatus(`生成分享版：渲染第 ${i + 1}/${total} 张图表…`);
      const blob = await renderMermaidToPngBlob(code);
      setStatus(`生成分享版：上传第 ${i + 1}/${total} 张…`);
      const fname = `mermaid-${hash.slice(0, 12)}-${i}.png`;
      const up = await uploadBinary(await blob.arrayBuffer(), fname, (frac) =>
        setProgress((done + frac) / total),
        undefined,
        'mermaid',
      );
      images.push({ qiniu_key: up.key, url: up.url, mermaid_hash: hash });
      // 写入缓存，供以后相同内容复用
      void fetch('/api/mermaid-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, key: up.key, url: up.url }),
      }).catch(() => {});
      result += `![图 ${i + 1}](${up.url})\n`;
      last = start + full.length;
      done++;
      setProgress(done / total);
      i++;
    }
    result += md.slice(last);

    // 同时把分享版 .md（图片已替换为远程链接）与渲染好的 .html 一起传到七牛，
    // 分享记录里可直接查看这两份文件。
    setStatus('生成分享版：上传 .md 与 .html…');
    const ts = Date.now();
    const mdBlob = new Blob([result], { type: 'text/markdown;charset=utf-8' });
    mdUrl = (await uploadBinary(await mdBlob.arrayBuffer(), `share-${ts}.md`, undefined, 'share', 'share')).url;
    const html = buildShareHtmlDoc(result, deriveTitle(result, currentFilename));
    const htmlBlob = new Blob([html], { type: 'text/html;charset=utf-8' });
    htmlUrl = (await uploadBinary(await htmlBlob.arrayBuffer(), `share-${ts}.html`, undefined, 'share', 'share')).url;
  } catch (e) {
    setStatus('生成分享版失败：' + (e as Error).message, true);
    setProgress(null);
    return;
  }

  // 记录元信息到 SQLite（即使弹窗展示失败也先存）
  let shareId: number | null = null;
  try {
    const r = (await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc_key: currentDocKey,
        share_md: result,
        images,
        md_url: mdUrl,
        html_url: htmlUrl,
      }),
    }).then((r) => r.json())) as { id: number };
    shareId = r.id ?? null;
    // 刚发布成功，刷新一致性基准（角标消失或反映新状态）
    void refreshPublishBaseline();
  } catch {
    /* 忽略离线 */
  }

  showShareModal(result, shareId);
  const reused = cacheHits > 0 ? `，复用缓存 ${cacheHits} 张` : '';
  setStatus(`已生成分享版（${images.length} 张图${reused}，.md 与 .html 已上传七牛）并记录到数据库`);
  setTimeout(() => setProgress(null), 500);
}

// ─── 分享结果弹窗 ───────────────────────────────────────
function showShareModal(shareMd: string, shareId?: number | null): void {
  currentShareId = shareId ?? null;
  let modal = document.getElementById('share-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <span>分享版 Markdown（图片已替换为远程链接）</span>
          <button id="share-close" type="button">✕</button>
        </div>
        <textarea id="share-text" readonly spellcheck="false"></textarea>
      <div class="modal-foot">
        <button id="share-upload" type="button">上传 HTML 到七牛</button>
        <button id="share-dl-html" type="button">下载 HTML</button>
        <button id="share-copy" type="button">复制</button>
        <button id="share-download" type="button">下载 .md</button>
      </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal!.remove();
    });
    $('share-close').addEventListener('click', () => modal!.remove());
    $('share-copy').addEventListener('click', async () => {
      const t = $('share-text') as HTMLTextAreaElement;
      await navigator.clipboard.writeText(t.value);
      setStatus('已复制到剪贴板');
    });
    $('share-download').addEventListener('click', () => {
      const t = $('share-text') as HTMLTextAreaElement;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([t.value], { type: 'text/markdown' }));
      a.download = (currentFilename || 'doc') + '.share.md';
      a.click();
    });
    $('share-dl-html').addEventListener('click', () => {
      const t = $('share-text') as HTMLTextAreaElement;
      const html = buildShareHtmlDoc(t.value, deriveTitle(t.value, currentFilename));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = (currentFilename || 'doc') + '.share.html';
      a.click();
    });
    $('share-upload').addEventListener('click', () => uploadShareHtml());
  }
  (modal.querySelector('#share-text') as HTMLTextAreaElement).value = shareMd;
  modal.classList.add('open');
}

/** 上传分享版 HTML 到七牛，复制永久 URL，并把链接回写 shares 表对应记录。 */
async function uploadShareHtml(): Promise<void> {
  const text = ($('share-text') as HTMLTextAreaElement).value;
  setStatus('正在上传 HTML 到七牛…');
  setProgress(0);
  try {
    const html = buildShareHtmlDoc(text);
    const buf = await new Blob([html], { type: 'text/html' }).arrayBuffer();
    const fname = `share-${Date.now()}.html`;
    const up = await uploadBinary(buf, fname, setProgress, 'share', 'share');
    setProgress(1);
    await navigator.clipboard.writeText(up.url);
    if (currentShareId != null) {
      try {
        await fetch(`/api/share/${currentShareId}/html`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html_url: up.url }),
        });
        setStatus('已上传，永久链接已复制并入库：' + up.url);
      } catch {
        setStatus('已上传，永久链接已复制：' + up.url + '（记录入库失败）');
      }
    } else {
      setStatus('已上传并复制永久链接：' + up.url);
    }
  } catch (e) {
    setStatus('上传失败：' + (e as Error).message, true);
  } finally {
    setTimeout(() => setProgress(null), 400);
  }
}

// ─── 文档互链（预览内 .md 相对链接站内跳转）─────────────
let docsIndex = new Map<string, number>(); // doc_key -> id

async function refreshDocsIndex(): Promise<void> {
  try {
    const res = await fetch('/api/docs');
    const docs = (await res.json()) as Array<{ id: number; doc_key: string }>;
    docsIndex = new Map(docs.map((d) => [d.doc_key, d.id]));
  } catch {
    /* 离线时保持旧索引 */
  }
}

/** 由当前文档 doc_key + 相对 href 解析出目标 doc_key（支持 ../ 与锚点）。 */
function resolveDocKey(currentKey: string, href: string): string | null {
  const clean = href.split('#')[0];
  const dir = currentKey.includes('/') ? currentKey.slice(0, currentKey.lastIndexOf('/')) : '';
  const segs = dir ? dir.split('/') : [];
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  const joined = segs.join('/');
  return joined || null;
}

function bindInternalLinks(): void {
  preview.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:|tel:|#)/i.test(href)) return;
    if (!href.includes('.md')) return;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      void openInternalLink(href);
    });
  });
}

async function openInternalLink(href: string): Promise<void> {
  const targetKey = resolveDocKey(currentDocKey, href);
  if (!targetKey) return;
  let id = docsIndex.get(targetKey);
  if (id == null) {
    await refreshDocsIndex();
    id = docsIndex.get(targetKey);
  }
  if (id != null) {
    await openDocById(id);
  } else {
    setStatus('工作区中未找到文档：' + targetKey, true);
    window.open(href, '_blank'); // 回退为普通链接
  }
}

// ─── 历史 / 搜索 ────────────────────────────────────────
$('history').addEventListener('click', toggleHistory);

// 当前列表（供键盘上下选择 / 补全）
let historyItems: Array<{ id: number; doc_key: string }> = [];
let historyActive = -1;

function toggleHistory(): void {
  const drawer = ensureHistoryDrawer();
  drawer.classList.toggle('open');
  if (drawer.classList.contains('open')) {
    const search = $('history-search') as HTMLInputElement;
    search.value = '';
    search.focus();
    refreshHistory('');
  }
}

function ensureHistoryDrawer(): HTMLElement {
  let drawer = document.getElementById('history-drawer');
  if (drawer) return drawer;
  drawer = document.createElement('div');
  drawer.id = 'history-drawer';
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="drawer-head">
      <input id="history-search" type="search" placeholder="搜索 / 快速打开（↑↓ 选择，↵ 打开）…" />
      <button id="history-close" type="button">✕</button>
    </div>
    <ul id="history-list" class="history-list"></ul>`;
  document.body.appendChild(drawer);
  const search = $('history-search') as HTMLInputElement;
  search.addEventListener('input', () => {
    historyActive = -1;
    refreshHistory(search.value);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveHistory(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveHistory(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openHistoryActive(); }
    else if (e.key === 'Escape') { drawer.classList.remove('open'); }
  });
  $('history-close').addEventListener('click', () => drawer.classList.remove('open'));
  return drawer;
}

function moveHistory(delta: number): void {
  if (historyItems.length === 0) return;
  historyActive = (historyActive + delta + historyItems.length) % historyItems.length;
  const nodes = $('history-list').querySelectorAll('.history-item');
  nodes.forEach((n, i) => n.classList.toggle('active', i === historyActive));
  (nodes[historyActive] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
}

function openHistoryActive(): void {
  const item = historyItems[historyActive];
  if (item) openDocById(item.id);
}

// 全文搜索索引（MiniSearch，惰性构建）：跨文档搜标题/文件名/正文
let searchIndex: MiniSearch | null = null;
let searchDocs: Array<{
  id: number; doc_key: string; title: string; filename: string; content: string;
}> = [];

async function ensureSearchIndex(): Promise<void> {
  if (searchIndex) return;
  const res = await fetch('/api/docs/full');
  searchDocs = (await res.json()) as typeof searchDocs;
  searchIndex = new MiniSearch({
    fields: ['title', 'filename', 'content'],
    storeFields: ['id', 'doc_key', 'title'],
  });
  searchIndex.addAll(searchDocs);
}

/** 提取正文中关键词附近的片段（代码块与 markdown 符号先剔除）。 */
function makeSnippet(content: string, q: string): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>\[\]()!\-_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let idx = -1;
  for (const t of terms) {
    const i = plain.toLowerCase().indexOf(t);
    if (i >= 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return plain.slice(0, 60) + (plain.length > 60 ? '…' : '');
  const start = Math.max(0, idx - 18);
  const end = Math.min(plain.length, idx + 62);
  return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}

function renderSearchResults(q: string, list: HTMLElement): void {
  list.innerHTML = '';
  historyItems = [];
  historyActive = -1;
  if (!searchIndex) return;
  let results: Array<{ id: number }>;
  try {
    results = (searchIndex.search(q, { prefix: true, fuzzy: 0.2 }) as Array<{ id: number }>).slice(
      0,
      30,
    );
  } catch {
    list.innerHTML = '<li class="empty">搜索失败</li>';
    return;
  }
  if (results.length === 0) {
    list.innerHTML = '<li class="empty">没有匹配的文档</li>';
    return;
  }
  results.forEach((h, idx) => {
    const doc = searchDocs.find((d) => d.id === h.id);
    if (!doc) return;
    const li = document.createElement('li');
    li.className = 'history-item' + (idx === 0 ? ' active' : '');
    li.innerHTML = `<div class="hi-title">${escapeHtml(doc.title)}</div>
                    <div class="hi-meta">${escapeHtml(doc.doc_key)} · ${escapeHtml(makeSnippet(doc.content, q))}</div>`;
    li.addEventListener('click', () => openDocById(doc.id));
    li.addEventListener('mousemove', () => {
      historyActive = idx;
      list.querySelectorAll('.history-item').forEach((n, i) => n.classList.toggle('active', i === idx));
    });
    list.appendChild(li);
    historyItems.push({ id: doc.id, doc_key: doc.doc_key });
  });
  historyActive = 0;
}

async function refreshHistory(q: string): Promise<void> {
  const list = $('history-list');
  if (q.trim()) {
    try {
      await ensureSearchIndex();
    } catch {
      list.innerHTML = '<li class="empty">索引加载失败</li>';
      return;
    }
    renderSearchResults(q.trim(), list);
    return;
  }
  // 无输入：按"最近打开"列出
  try {
    const res = await fetch('/api/docs');
    const docs = (await res.json()) as Array<{
      id: number; doc_key: string; title: string; filename: string; last_opened_at: number;
    }>;
    list.innerHTML = '';
    historyItems = docs.map((d) => ({ id: d.id, doc_key: d.doc_key }));
    historyActive = -1;
    if (docs.length === 0) {
      list.innerHTML = '<li class="empty">暂无记录</li>';
      return;
    }
    docs.forEach((d, idx) => {
      const li = document.createElement('li');
      li.className = 'history-item';
      const when = relativeTime(d.last_opened_at || 0);
      li.innerHTML = `<div class="hi-title">${escapeHtml(d.title)}</div>
                      <div class="hi-meta">${escapeHtml(d.filename)} · ${when}</div>`;
      if (idx === 0) li.classList.add('active');
      li.addEventListener('click', () => openDocById(d.id));
      li.addEventListener('mousemove', () => {
        historyActive = idx;
        list.querySelectorAll('.history-item').forEach((n, i) => n.classList.toggle('active', i === idx));
      });
      list.appendChild(li);
    });
    historyActive = 0;
  } catch {
    list.innerHTML = '<li class="empty">加载失败</li>';
  }
}

async function openDocById(id: number): Promise<void> {
  try {
    const res = await fetch('/api/docs/' + id);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = (await res.json()) as { content: string; filename: string; doc_key: string };
    // 优先用已保存的文件句柄直接读真实文件（无需再选路径）
    const handle = await getHandle(doc.doc_key);
    if (handle) {
      try {
        const file = await handle.getFile();
        const content = await file.text();
        setDocSource('disk', '磁盘实时', '通过已保存的文件句柄读取了磁盘上的最新内容；下次打开仍会自动重读');
        loadContent(doc.doc_key, doc.filename, content);
        setStatus('已打开（磁盘实时）：' + doc.filename);
        return;
      } catch {
        // 句柄失效则回退，并在下方说明原因
        setDocSource(
          'snapshot',
          '数据库快照',
          '文件句柄失效（文件可能已被移动/删除，或浏览器权限丢失），无法重读磁盘，已回退到上次保存的快照',
        );
        loadContent(doc.doc_key, doc.filename, doc.content);
        setStatus('已打开（数据库快照）：' + doc.filename + '。文件句柄失效，无法重读磁盘');
        return;
      }
    }
    setDocSource(
      'snapshot',
      '数据库快照',
      '未保存文件句柄（该文件不是通过系统文件选择器打开的），无法自动重读磁盘，显示的是上次保存的快照',
    );
    loadContent(doc.doc_key, doc.filename, doc.content);
    setStatus('已打开（数据库快照）：' + doc.filename + '。未保存文件句柄，无法重读磁盘');
  } catch (e) {
    setStatus('打开失败：' + (e as Error).message, true);
  }
}

function relativeTime(ts: number): string {
  if (!ts) return '从未打开';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 2592000) return Math.floor(s / 86400) + ' 天前';
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

// ─── 分享记录管理 ───────────────────────────────────────
$('share-list').addEventListener('click', toggleShareListDrawer);

interface ShareRow {
  id: number;
  doc_key: string | null;
  md_url: string | null;
  html_url: string | null;
  created_at: number;
}

function toggleShareListDrawer(): void {
  const drawer = ensureShareListDrawer();
  drawer.classList.toggle('open');
  if (drawer.classList.contains('open')) void refreshShareList();
}

function ensureShareListDrawer(): HTMLElement {
  let drawer = document.getElementById('share-list-drawer');
  if (drawer) return drawer;
  drawer = document.createElement('div');
  drawer.id = 'share-list-drawer';
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="drawer-head">
      <span class="drawer-title">分享记录</span>
      <button id="share-list-close" type="button">✕</button>
    </div>
    <ul id="share-list-body" class="history-list"></ul>`;
  document.body.appendChild(drawer);
  $('share-list-close').addEventListener('click', () => drawer!.classList.remove('open'));
  const body = $('share-list-body') as HTMLElement;
  body.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
    const li = (e.target as HTMLElement).closest<HTMLElement>('.share-row');
    if (!btn || !li) return;
    const id = Number(li.dataset.id);
    const op = btn.dataset.op;
    if (op === 'copy') void copyShareLink(id);
    else if (op === 'open') openShareLink(id);
    else if (op === 'md') void viewShareMd(id);
    else if (op === 'delete') void deleteShareRecord(id);
  });
  return drawer;
}

async function refreshShareList(): Promise<void> {
  const body = $('share-list-body') as HTMLElement;
  body.innerHTML = '<li class="empty">加载中…</li>';
  try {
    const res = await fetch('/api/share');
    const rows = (await res.json()) as ShareRow[];
    body.innerHTML = '';
    if (rows.length === 0) {
      body.innerHTML = '<li class="empty">暂无分享记录</li>';
      return;
    }
    rows.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'share-row history-item';
      li.dataset.id = String(s.id);
      const when = relativeTime(s.created_at);
      const published = s.html_url && s.md_url;
      const linkState = published ? '已发布' : s.html_url ? '已发布(仅HTML)' : '仅托管';
      li.innerHTML = `
        <div class="hi-title">${escapeHtml(s.doc_key || '未命名')}</div>
        <div class="hi-meta">${linkState} · ${when}</div>
        <div class="share-row-ops">
          <button data-op="open" type="button">HTML</button>
          <button data-op="md" type="button">MD</button>
          <button data-op="copy" type="button">复制链接</button>
          <button data-op="delete" type="button">删除</button>
        </div>`;
      body.appendChild(li);
    });
  } catch {
    body.innerHTML = '<li class="empty">加载失败</li>';
  }
}

function shareLinkOf(s: ShareRow): string {
  return s.html_url || location.origin + '/s/' + s.id;
}

async function copyShareLink(id: number): Promise<void> {
  const res = await fetch('/api/share');
  const rows = (await res.json()) as ShareRow[];
  const s = rows.find((r) => r.id === id);
  if (!s) return;
  try {
    await navigator.clipboard.writeText(shareLinkOf(s));
    setStatus('已复制分享链接：' + shareLinkOf(s));
  } catch (e) {
    setStatus('复制失败：' + (e as Error).message, true);
  }
}

function openShareLink(id: number): void {
  void (async () => {
    const res = await fetch('/api/share');
    const rows = (await res.json()) as ShareRow[];
    const row = rows.find((r) => r.id === id);
    if (row) window.open(shareLinkOf(row), '_blank');
  })();
}

/** 查看分享版 .md 内容：拉取服务端存的 share_md 弹窗展示，另附七牛上 .md 文件的永久链接。 */
function viewShareMd(id: number): void {
  void (async () => {
    let row: { doc_key: string | null; share_md: string; md_url: string | null } | undefined;
    try {
      const res = await fetch(`/api/share/${id}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      row = await res.json();
    } catch (e) {
      setStatus('获取分享内容失败：' + (e as Error).message, true);
      return;
    }
    let modal = document.getElementById('md-view-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'md-view-modal';
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal">
          <div class="modal-head">
            <span>分享版 Markdown 内容</span>
            <button id="md-view-close" type="button">✕</button>
          </div>
          <textarea id="md-view-text" readonly spellcheck="false"></textarea>
          <div class="modal-foot">
            <a id="md-view-link" href="#" target="_blank" rel="noopener"
               style="align-self:center;color:#2563eb;font-size:13px;text-decoration:none">打开七牛上的 .md 文件</a>
            <button id="md-view-copy" type="button">复制</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal!.remove();
      });
      $('md-view-close').addEventListener('click', () => modal!.remove());
      $('md-view-copy').addEventListener('click', async () => {
        const t = $('md-view-text') as HTMLTextAreaElement;
        await navigator.clipboard.writeText(t.value);
        setStatus('已复制 Markdown 内容');
      });
    }
    (modal.querySelector('#md-view-text') as HTMLTextAreaElement).value = row!.share_md;
    const link = modal.querySelector('#md-view-link') as HTMLAnchorElement;
    if (row!.md_url) {
      link.href = row!.md_url;
      link.style.display = '';
    } else {
      link.href = '#';
      link.style.display = 'none';
    }
    modal.classList.add('open');
  })();
}

async function deleteShareRecord(id: number): Promise<void> {
  if (!confirm('删除这条分享记录？\n仅删除本地记录，七牛上已发布的 HTML 仍可访问。')) return;
  try {
    const res = await fetch(`/api/share/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    setStatus('已删除分享记录');
    void refreshShareList();
  } catch (e) {
    setStatus('删除失败：' + (e as Error).message, true);
  }
}

// ─── 版本快照 ───────────────────────────────────────────
interface SnapshotRow {
  id: number;
  doc_id: number;
  content: string;
  label: string | null;
  created_at: number;
}

$('snapshots').addEventListener('click', toggleSnapshotDrawer);

function toggleSnapshotDrawer(): void {
  const drawer = ensureSnapshotDrawer();
  drawer.classList.toggle('open');
  if (drawer.classList.contains('open')) void refreshSnapshots();
}

function ensureSnapshotDrawer(): HTMLElement {
  let drawer = document.getElementById('snapshot-drawer');
  if (drawer) return drawer;
  drawer = document.createElement('div');
  drawer.id = 'snapshot-drawer';
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="drawer-head">
      <span class="drawer-title">版本快照</span>
      <button id="snapshot-new" type="button">保存快照</button>
      <button id="snapshot-close" type="button">✕</button>
    </div>
    <ul id="snapshot-list" class="history-list"></ul>`;
  document.body.appendChild(drawer);
  $('snapshot-close').addEventListener('click', () => drawer!.classList.remove('open'));
  $('snapshot-new').addEventListener('click', () => void saveSnapshot());
  const list = $('snapshot-list') as HTMLElement;
  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
    const li = (e.target as HTMLElement).closest<HTMLElement>('.snapshot-item');
    if (!btn || !li) return;
    const snap: SnapshotRow = JSON.parse(li.dataset.snap || '{}');
    const op = btn.dataset.op;
    if (op === 'preview') previewSnapshot(snap);
    else if (op === 'restore') void restoreSnapshot(snap);
    else if (op === 'delete') void deleteSnapshot(snap);
  });
  return drawer;
}

async function refreshSnapshots(): Promise<void> {
  const list = $('snapshot-list') as HTMLElement;
  if (currentDocId == null) {
    list.innerHTML = '<li class="empty">请先保存或打开一篇文档</li>';
    return;
  }
  try {
    const res = await fetch(`/api/docs/${currentDocId}/snapshots`);
    const snaps = (await res.json()) as SnapshotRow[];
    list.innerHTML = '';
    if (snaps.length === 0) {
      list.innerHTML = '<li class="empty">暂无快照，点「保存快照」记录当前版本</li>';
      return;
    }
    snaps.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'snapshot-item';
      li.dataset.snap = JSON.stringify(s);
      const preview = s.content.replace(/\s+/g, ' ').slice(0, 42);
      li.innerHTML = `
        <div class="snap-label">${escapeHtml(s.label || '未命名')}</div>
        <div class="hi-meta">${relativeTime(s.created_at)} · ${preview}${s.content.length > 42 ? '…' : ''}</div>
        <div class="snap-ops">
          <button data-op="preview" type="button">预览</button>
          <button data-op="restore" type="button">恢复</button>
          <button data-op="delete" type="button">删除</button>
        </div>`;
      list.appendChild(li);
    });
  } catch {
    list.innerHTML = '<li class="empty">加载失败</li>';
  }
}

async function saveSnapshot(): Promise<void> {
  if (currentDocId == null) {
    setStatus('请先保存或打开一篇文档', true);
    return;
  }
  const label = prompt('快照标签（可留空，如 v1 评审稿）', '')?.trim() || undefined;
  try {
    const res = await fetch(`/api/docs/${currentDocId}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    setStatus('已保存快照' + (label ? '：' + label : ''));
    void refreshSnapshots();
  } catch (e) {
    setStatus('保存快照失败：' + (e as Error).message, true);
  }
}

/** 只读预览快照内容，可在弹窗内直接恢复。 */
function previewSnapshot(snap: SnapshotRow): void {
  let modal = document.getElementById('snap-preview-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'snap-preview-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <span>快照预览（只读）</span>
          <button id="snap-preview-close" type="button">✕</button>
        </div>
        <textarea id="snap-preview-text" readonly spellcheck="false"></textarea>
        <div class="modal-foot">
          <button id="snap-preview-restore" type="button">恢复此版本</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal!.remove();
    });
    $('snap-preview-close').addEventListener('click', () => modal!.remove());
    $('snap-preview-restore').addEventListener('click', () => {
      modal!.remove();
      void restoreSnapshot(snap);
    });
  }
  ($('snap-preview-text') as HTMLTextAreaElement).value = snap.content;
  modal.classList.add('open');
}

async function restoreSnapshot(snap: SnapshotRow): Promise<void> {
  if (currentDocId == null) return;
  if (!confirm(`恢复到「${snap.label || '未命名'}」？\n将覆盖当前内容，系统会先自动保留一个"恢复前"快照。`)) return;
  try {
    // 恢复前自动留一个兜底快照
    await fetch(`/api/docs/${currentDocId}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '恢复前自动保存' }),
    });
    const res = await fetch(`/api/docs/${currentDocId}/snapshots/${snap.id}/restore`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    setDocSource('snapshot', '版本快照', '恢复的是历史版本快照的内容，并非当前磁盘文件；保存后快照内容会写入数据库');
    loadContent(currentDocKey, currentFilename, snap.content);
    setStatus('已恢复到快照：' + (snap.label || '未命名'));
    void refreshSnapshots();
  } catch (e) {
    setStatus('恢复失败：' + (e as Error).message, true);
  }
}

async function deleteSnapshot(snap: SnapshotRow): Promise<void> {
  if (!confirm('删除该快照？不影响当前文档内容。')) return;
  try {
    await fetch(`/api/docs/${currentDocId}/snapshots/${snap.id}`, { method: 'DELETE' });
    setStatus('已删除快照');
    void refreshSnapshots();
  } catch (e) {
    setStatus('删除快照失败：' + (e as Error).message, true);
  }
}

// ─── 启动（登录后才加载工作区）──────────────────────────
$('toc-toggle').addEventListener('click', () => toggleToc());

editor.addEventListener('input', () => {
  scheduleRender();
  scheduleSave();
  schedulePublishCheck();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p')) {
    e.preventDefault();
    toggleHistory();
  }
});

void startGate((user: SessionUser) => {
  setHandleUser(user.id);
  searchIndex = null;
  searchDocs = [];
  currentDocKey = 'default';
  currentFilename = 'index.md';
  currentDocId = null;
  editor.value = '';
  preview.innerHTML = '';

  const who = $('whoami');
  who.hidden = false;
  who.textContent = user.username + (user.role === 'admin' ? ' · 管理员' : '');
  $('logout').hidden = false;
  $('logout').onclick = () => void logout();

  const settings = initSettingsPanel({ onStatus: setStatus });
  $('settings').addEventListener('click', () => settings.toggle());

  if (user.role === 'admin') {
    $('admin').hidden = false;
    const admin = initAdminPanel({ onStatus: setStatus });
    $('admin').addEventListener('click', () => admin.toggle());
  }

  const mediaPanel = initMediaPanel({
    onInsert: (url, filename) => {
      insertAtCursor(`\n![${filename}](${url})\n`);
      render();
    },
    onStatus: setStatus,
  });
  $('media').addEventListener('click', () => mediaPanel.toggle());

  sidebarRef = initSidebar({
    onOpen: (id) => void openDocById(id),
    getCurrentKey: () => currentDocKey,
    onStatus: setStatus,
    onRenamed: (oldKey, newKey) => {
      if (currentDocKey === oldKey) {
        currentDocKey = newKey;
        currentFilename = newKey.slice(newKey.lastIndexOf('/') + 1);
        void refreshPublishBaseline();
      }
      setStatus('已重命名为：' + newKey);
    },
  });

  void refreshDocsIndex();
  loadDefaultDoc();
});
