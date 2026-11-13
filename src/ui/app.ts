import { siteConfig } from '../config';
import { renderMarkdown } from '../core/markdown';
import { renderMermaidBlocks } from '../core/mermaid';
import MiniSearch from 'minisearch';
import { saveHandle, getHandle, removeHandle, setHandleUser } from './fileHandles';
import { askConfirm } from './dialog';
import { renderToc, attachTocScrollHighlight } from './toc';
import { initSidebar } from './sidebar';
import { initMediaPanel } from './media';
import { startGate, logout, type SessionUser } from './gate';
import { initSettingsPanel, type SettingsSectionId, syncSettingsDots } from './settings';
import { initAdminPanel } from './admin';
import { initAgentChat } from './agent-chat';
import { initOverlayManager, closeTopOverlay } from './overlay';
import { initScrollSync } from './scroll-sync';
import { initVersionsDrawer } from './versions';
import { showToast } from './toast';
import { paintStatus } from './status-line';
import {
  initArchivePage,
  initArchiveToolbar,
  markArchiveStatusUnknown,
  refreshArchiveList,
  refreshArchiveStatus,
} from './archive';

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
  void renderMermaidBlocks(preview);
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
  syncChrome();
}
function scheduleRender(): void {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, 200);
}
function setStatus(msg: string, isError = false): void {
  // 错误只走 toast 这一条通路：状态栏写「操作失败」标记，具体原因在 toast 里只说一次。
  // 以前两处都写同一句，屏幕上出现两遍；分工与理由见 status-line.ts。
  const p = paintStatus(msg, isError);
  statusEl.textContent = p.text;
  statusEl.className = 'status' + (p.error ? ' error' : '');
  if (p.toast) showToast(p.toast, 'error');
}

// ─── 保存状态（状态栏右侧，和瞬时提示分开）────────────────
function setSaveState(state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'): void {
  const el = $('save-state');
  const at = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  el.className = 'save-state' + (state === 'error' ? ' error' : '');
  el.textContent =
    state === 'dirty' ? '未保存'
    : state === 'saving' ? '保存中…'
    : state === 'saved' ? '已保存 ' + at
    : state === 'error' ? '未保存（离线）'
    : '';
}

/** 更新顶栏的当前文档内容来源标记（标签 + 悬停原因）。 */
function setDocSource(kind: DocSourceKind, label: string, reason: string): void {
  currentDocSource = { kind, label, reason };
  const el = $('doc-source');
  el.hidden = false;
  el.className = 'doc-source kind-' + kind;
  el.textContent = label;
  el.title = reason;
  syncChrome();
}

function syncChrome(): void {
  const titleEl = $('doc-title');
  const pathEl = $('doc-path');
  const heading = editor.value.match(/^#\s+(.+)$/m);
  const title = (heading ? heading[1].trim() : currentFilename || currentDocKey || '未命名').slice(0, 80);
  titleEl.textContent = title;
  titleEl.title = currentDocKey;
  pathEl.textContent = currentDocKey;
}

type WorkspaceView = 'edit' | 'split' | 'preview';
let workspaceView: WorkspaceView = 'split';

// ─── 布局偏好持久化（视图 / 侧栏 / 分栏比例 / 目录 / 主题）──
// 刷新后布局保持原样，不用每次重新摆一遍。
const PREF_KEY = 'ptdoc.prefs';
const SPLIT_MIN = 0.28;
const SPLIT_MAX = 0.72;
const SIDEBAR_W_MIN = 220;
const SIDEBAR_W_MAX = 460;

interface Prefs {
  view?: WorkspaceView;
  sidebar?: boolean;
  sidebarW?: number;
  split?: number;
  toc?: boolean;
  theme?: ThemeMode;
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}

function writePref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), [key]: value }));
  } catch {
    /* 隐私模式禁用 localStorage：忽略，不影响功能 */
  }
}

function setSplitRatio(main: HTMLElement, left: number): void {
  const l = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, left));
  main.style.gridTemplateColumns = l + 'fr 6px ' + (1 - l) + 'fr';
}

/** 侧栏宽度：写 --sidebar-w 变量，不摸 grid模板，折叠/移动端媒体查询仍能接管。*/
function setSidebarWidth(ws: HTMLElement, w: number): number {
  const cw = Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(w)));
  ws.style.setProperty('--sidebar-w', cw + 'px');
  return cw;
}

// 主题默认跟随系统；index.html 里有一段同样的预置脚本，避免首帧闪白。
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
const THEME_ORDER = ['auto', 'light', 'dark'] as const;
type ThemeMode = (typeof THEME_ORDER)[number];

function applyTheme(): void {
  const mode = readPrefs().theme ?? 'auto';
  const dark = mode === 'dark' || (mode === 'auto' && themeMedia.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('theme-toggle');
  const label = mode === 'auto' ? '跟随系统' : mode === 'light' ? '浅色' : '深色';
  btn.title = '外观：' + label + '（点击切换）';
  btn.setAttribute('aria-label', btn.title);
}

function initTheme(): void {
  applyTheme();
  themeMedia.addEventListener('change', () => {
    if ((readPrefs().theme ?? 'auto') === 'auto') applyTheme();
  });
  $('theme-toggle').addEventListener('click', () => {
    const cur = readPrefs().theme ?? 'auto';
    writePref('theme', THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length]);
    applyTheme();
  });
}

function setWorkspaceView(view: WorkspaceView): void {
  workspaceView = view;
  writePref('view', view);
  document.body.classList.toggle('view-edit', view === 'edit');
  document.body.classList.toggle('view-preview', view === 'preview');
  document.body.classList.toggle('view-split', view === 'split');
  const main = document.querySelector('.workspace-main') as HTMLElement | null;
  if (main && (view !== 'split' || isMobileLayout())) main.style.gridTemplateColumns = '';
  for (const id of ['view-edit', 'view-split', 'view-preview'] as const) {
    const btn = $(id);
    const on = btn.dataset.view === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

function isMobileLayout(): boolean {
  return window.matchMedia('(max-width: 860px)').matches;
}

function setSidebarOpen(open: boolean): void {
  const btn = $('sidebar-toggle');
  const backdrop = $('sidebar-backdrop');
  if (isMobileLayout()) {
    document.body.classList.toggle('sidebar-open', open);
    document.body.classList.toggle('sidebar-collapsed', !open);
    backdrop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = open ? '关闭文档树' : '打开文档树';
    return;
  }
  document.body.classList.toggle('sidebar-collapsed', !open);
  document.body.classList.remove('sidebar-open');
  backdrop.hidden = true;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.title = open ? '折叠侧边栏' : '展开侧边栏';
  writePref('sidebar', open);
}

// ─── Workbench 一级导航（视图/检索/场景/集成）──────────────
// 顶栏 Tab 决定左侧 Sider 显示哪一页；检索/场景的树形导航直接住在 Sider 里，
// 不再走右侧抽屉。切到非视图页时如果侧栏是收起的，自动展开。
type NavPage = 'docs' | 'agent' | 'archive' | 'settings';
let navPage: NavPage = 'docs';

function setNav(page: NavPage): void {
  navPage = page;
  document.body.dataset.nav = page;
  document.querySelectorAll<HTMLButtonElement>('.nav-tabs button').forEach((b) => {
    const on = b.dataset.nav === page;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  // Sider 分页 + 主界面双切（Workbench：每个 Tab = Sider 导航 + 主界面）
  // 四个 Tab：文档 / 智能体 / 归档（产物列表）/ 设置
  document.querySelectorAll<HTMLElement>('.sider-page').forEach((p) => {
    p.classList.toggle('active', p.dataset.page === page);
  });
  document.querySelectorAll<HTMLElement>('.main-page').forEach((m) => {
    m.classList.toggle('active', m.dataset.main === page);
  });
  // 文档工作台工具条（视图切换+文档操作）仅文档页有意义
  const toolbar = document.querySelector('.workspace-toolbar') as HTMLElement | null;
  if (toolbar) toolbar.style.display = page === 'docs' ? '' : 'none';
  if (page !== 'docs') {
    if (isMobileLayout()) setSidebarOpen(true);
    else if (document.body.classList.contains('sidebar-collapsed')) setSidebarOpen(true);
  }
  if (page === 'agent') void refreshNavConvs();
  if (page === 'archive') void refreshArchiveList();
  if (page === 'settings') void syncSettingsDots();
}

function initNav(): void {
  document.querySelectorAll<HTMLButtonElement>('.nav-tabs button').forEach((b) => {
    b.addEventListener('click', () => setNav(b.dataset.nav as NavPage));
  });
}

// ─── 顶栏宽屏收纳 ────────────────────────────────────────
// 窄屏时顶栏十几个按钮会横向溢出（溢出部分还会被 overflow-x 隐掉看不见），
// 把次要按钮（目录/快照/历史/智能体）搬进「更多」菜单；宽屏再搬回原位。
// 用移动节点（而不是写两份按钮）避免重复 id，原来挂的监听也不会丢。
const MORE_MENU_QUERY = window.matchMedia('(max-width: 1100px)');
const MORE_MENU_IDS = ['toc-toggle', 'snapshots'];

function syncMoreMenu(): void {
  const menu = $('more-menu') as HTMLDetailsElement;
  const list = $('more-list');
  const group = $('action-secondary');
  for (const id of MORE_MENU_IDS) {
    const btn = $(id);
    if (MORE_MENU_QUERY.matches) list.appendChild(btn);
    else group.appendChild(btn);
  }
  if (!MORE_MENU_QUERY.matches) menu.open = false;
}

// 下拉菜单用 position: fixed（见 styles.css），要自己摆位置才能脱离 .actions 的
// overflow 裁剪；窗口尺寸变了就干脆关掉，下次打开重算。
function positionMoreMenu(): void {
  const menu = $('more-menu') as HTMLDetailsElement;
  if (!menu.open) return;
  const summary = menu.querySelector('summary') as HTMLElement;
  const r = summary.getBoundingClientRect();
  const list = $('more-list');
  list.style.top = r.bottom + 6 + 'px';
  list.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
}

function initMoreMenu(): void {
  const menu = $('more-menu') as HTMLDetailsElement;
  syncMoreMenu();
  MORE_MENU_QUERY.addEventListener('change', syncMoreMenu);
  menu.addEventListener('toggle', positionMoreMenu);
  // 点任意一项就收起，点别处也收起
  $('more-list').addEventListener('click', () => {
    menu.open = false;
  });
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
  window.addEventListener('resize', () => {
    menu.open = false;
  });
}

function initLayoutChrome(): void {
  const prefs = readPrefs();
  initNav();
  setWorkspaceView(isMobileLayout() ? 'edit' : prefs.view ?? 'split');
  setSidebarOpen(prefs.sidebar ?? !isMobileLayout());
  const ws = document.querySelector('.workspace') as HTMLElement;
  const mainEl = document.querySelector('.workspace-main') as HTMLElement | null;
  if (mainEl && workspaceView === 'split' && !isMobileLayout() && prefs.split) {
    setSplitRatio(mainEl, prefs.split);
  }
  if (prefs.sidebarW) setSidebarWidth(ws, prefs.sidebarW);
  if (prefs.toc) toggleToc(true);
  initMoreMenu();
  $('view-edit').addEventListener('click', () => setWorkspaceView('edit'));
  $('view-split').addEventListener('click', () => setWorkspaceView('split'));
  $('view-preview').addEventListener('click', () => setWorkspaceView('preview'));
  $('sidebar-toggle').addEventListener('click', () => {
    // 非「文档」页下侧栏就是当前导航的内容区，按钮回到「文档」页而不是把它关掉
    if (navPage !== 'docs') {
      setNav('docs');
      return;
    }
    const open = isMobileLayout()
      ? !document.body.classList.contains('sidebar-open')
      : document.body.classList.contains('sidebar-collapsed');
    setSidebarOpen(open);
  });
  $('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
  const handle = $('split-handle');
  const main = document.querySelector('.workspace-main') as HTMLElement;
  handle.addEventListener('pointerdown', (e) => {
    if (workspaceView !== 'split' || isMobileLayout()) return;
    e.preventDefault();
    const start = main.getBoundingClientRect();
    document.body.classList.add('resizing');
    let left = 0.5;
    const move = (ev: PointerEvent) => {
      left = (ev.clientX - start.left) / start.width;
      setSplitRatio(main, left);
    };
    const up = () => {
      writePref('split', Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, left)));
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const sidebarResize = $('sidebar-resize');
  sidebarResize.addEventListener('pointerdown', (e) => {
    if (isMobileLayout() || document.body.classList.contains('sidebar-collapsed')) return;
    e.preventDefault();
    const start = ws.getBoundingClientRect();
    document.body.classList.add('resizing');
    let w = SIDEBAR_W_MIN;
    const move = (ev: PointerEvent) => {
      w = setSidebarWidth(ws, ev.clientX - start.left);
    };
    const up = () => {
      writePref('sidebarW', w);
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', () => {
    if (isMobileLayout()) {
      const pane = document.querySelector('.workspace-main') as HTMLElement | null;
      if (pane) pane.style.gridTemplateColumns = '';
    }
    if (!isMobileLayout()) {
      document.body.classList.remove('sidebar-open');
      $('sidebar-backdrop').hidden = true;
    }
  });
}

// ─── 预览区目录 TOC ─────────────────────────────────────
let tocOpen = false;
let tocPanel: HTMLElement | null = null;

function ensureTocPanel(): HTMLElement {
  if (tocPanel && tocPanel.isConnected) return tocPanel;
  tocPanel = document.createElement('div');
  tocPanel.id = 'toc-panel';
  tocPanel.className = 'toc-panel';
  tocPanel.innerHTML =
    '<div class="toc-head"><span>目录</span><button id="toc-close" type="button">关闭</button></div>' +
    '<nav class="toc-body"></nav>';
  document.querySelector('.preview-pane')?.appendChild(tocPanel);
  $('toc-close').addEventListener('click', () => toggleToc(false));
  return tocPanel;
}

function toggleToc(force?: boolean): void {
  tocOpen = force ?? !tocOpen;
  writePref('toc', tocOpen);
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
let saveSeq = 0;
async function saveCurrentDoc(): Promise<void> {
  const seq = ++saveSeq;
  setSaveState('saving');
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
    if (seq === saveSeq) {
      setSaveState('saved');
      // 保存成功后才可能变成「有更新未归档」，徽标就地刷新（改一个字不用手动 F5）
      void refreshArchiveStatus();
    }
  } catch {
    /* 离线时静默忽略，但状态栏要如实显示 */
    if (seq === saveSeq) setSaveState('error');
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
    void refreshArchiveStatus({ force: true });
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
function loadContent(docKey: string, filename: string, content: string, docId: number | null = null): void {
  editor.value = content;
  currentDocKey = docKey;
  currentFilename = filename;
  // 按 id 打开时立刻拿到 id（删除/归档状态都依赖它）；其余来源等保存回来再填
  currentDocId = docId;
  markArchiveStatusUnknown();
  render();
  syncChrome();
  saveCurrentDoc();
  sidebarRef?.refresh();
  void refreshArchiveStatus({ force: true });
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

// ─── 全局搜索（顶栏搜索框：全文搜索 + 最近打开）───
// Ctrl+K 聚焦；有词全文搜索（MiniSearch），无词列出最近打开。

// 当前列表（供键盘上下选择 / 补全）
let historyItems: Array<{ id: number; doc_key: string }> = [];
let historyActive = -1;

function setNavSearchActive(idx: number): void {
  if (historyItems.length === 0) return;
  historyActive = (historyActive + idx + historyItems.length) % historyItems.length;
  const nodes = $('global-search-list').querySelectorAll('.history-item');
  nodes.forEach((n, i) => n.classList.toggle('active', i === historyActive));
  (nodes[historyActive] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
}

function openNavSearchActive(): void {
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
  const list = $('global-search-list');
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

function closeGlobalSearch(): void {
  $('global-search-pop').hidden = true;
}

function initGlobalSearch(): void {
  const input = $('global-search') as HTMLInputElement;
  const pop = $('global-search-pop');
  let closeTimer: number | undefined;
  const open = (): void => {
    historyActive = -1;
    void refreshHistory(input.value).then(() => {
      pop.hidden = false;
    });
  };
  input.addEventListener('focus', () => {
    clearTimeout(closeTimer);
    open();
  });
  input.addEventListener('input', open);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setNavSearchActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setNavSearchActive(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openNavSearchActive(); }
    else if (e.key === 'Escape') closeGlobalSearch();
  });
  // 延迟失焦收起：让结果项的 click 先触发
  input.addEventListener('blur', () => {
    closeTimer = window.setTimeout(closeGlobalSearch, 150);
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.global-search')) closeGlobalSearch();
  });
}

// ─── 智能体 Sider 导航（场景 + 会话列表）─────────────
// 场景切换 / 选中会话都在 Sider 完成；右侧主界面展示消息流与输入区。
interface NavConv { id: number; scene: 'qa' | 'writer'; title: string; }
let navConvs: NavConv[] = [];
let navScene: 'qa' | 'writer' = 'qa';

async function refreshNavConvs(): Promise<void> {
  const list = $('nav-convs');
  try {
    const rows = (await (await fetch('/api/agents/conversations?scene=' + navScene)).json()) as NavConv[];
    navConvs = rows || [];
  } catch {
    navConvs = [];
  }
  const count = document.querySelector<HTMLElement>(`[data-count="${navScene}"]`);
  if (count) count.textContent = String(navConvs.length);
  list.innerHTML = '';
  if (navConvs.length === 0) {
    list.innerHTML = '<li class="empty">暂无会话，点「新对话」开始</li>';
    return;
  }
  for (const c of navConvs) {
    const li = document.createElement('li');
    li.className = 'history-item nav-conv-item';
    li.innerHTML = `<div class="hi-title">${escapeHtml(c.title || '未命名')}</div>`;
    li.addEventListener('click', () => {
      const agentPanel = (window as any).__ptdocAgent;
      if (agentPanel) agentPanel.openConv(c.id, c.scene);
      else setStatus('智能体尚未就绪', true);
    });
    list.appendChild(li);
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
        loadContent(doc.doc_key, doc.filename, content, id);
        setStatus('已打开（磁盘实时）：' + doc.filename);
        return;
      } catch {
        // 句柄失效则回退，并在下方说明原因
        setDocSource(
          'snapshot',
          '数据库快照',
          '文件句柄失效（文件可能已被移动/删除，或浏览器权限丢失），无法重读磁盘，已回退到上次保存的快照',
        );
        loadContent(doc.doc_key, doc.filename, doc.content, id);
        setStatus('已打开（数据库快照）：' + doc.filename + '。文件句柄失效，无法重读磁盘');
        return;
      }
    }
    setDocSource(
      'snapshot',
      '数据库快照',
      '未保存文件句柄（该文件不是通过系统文件选择器打开的），无法自动重读磁盘，显示的是上次保存的快照',
    );
    loadContent(doc.doc_key, doc.filename, doc.content, id);
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

// ─── 版本时间线（M2-4）────────────────────────────────────
const versionsDrawer = initVersionsDrawer({
  getRef: () => (currentDocId != null ? currentDocId : currentDocKey || null),
  onStatus: setStatus,
  onRestored: (content) => {
    setDocSource('snapshot', '历史版本', '回滚的是历史版本的内容，并非当前磁盘文件；保存后版本内容会写入数据库');
    loadContent(currentDocKey, currentFilename, content);
  },
});
$('snapshots').addEventListener('click', () => versionsDrawer.toggle());

// ─── 启动（登录后才加载工作区）──────────────────────────
$('toc-toggle').addEventListener('click', () => toggleToc());
initLayoutChrome();
initTheme();
initOverlayManager();
// 分栏下编辑区与预览区双向联动；单栏时另一侧不可见，直接不同步。
initScrollSync(editor, preview, { isActive: () => workspaceView === 'split' && !isMobileLayout() });

editor.addEventListener('input', () => {
  setSaveState('dirty');
  scheduleRender();
  scheduleSave();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p')) {
    e.preventDefault();
    const input = $('global-search') as HTMLInputElement;
    input.focus();
    input.select();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    const open = isMobileLayout()
      ? !document.body.classList.contains('sidebar-open')
      : document.body.classList.contains('sidebar-collapsed');
    setSidebarOpen(open);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    clearTimeout(saveTimer);
    void saveCurrentDoc();
  }
  if (e.key === 'Escape') {
    // 先收顶栏的「更多」菜单（它是最小的浮层），再按 dialog / 模态 / 抽屉的顺序关；
    const menu = $('more-menu') as HTMLDetailsElement;
    if (menu.open) {
      menu.open = false;
      return;
    }
    if (closeTopOverlay()) return;
    if (isMobileLayout() && document.body.classList.contains('sidebar-open')) setSidebarOpen(false);
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
  // 配置项直达：点哪个组，设置主界面高亮并展开哪个分区
  document.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach((b) =>
    b.addEventListener('click', () => {
      settings.openSection(b.dataset.settingsSection as SettingsSectionId);
      syncSettingsDots();
    }),
  );

  const agent = initAgentChat({
    onStatus: setStatus,
    getCurrentDocId: () => currentDocId,
    insertAtCursor: (text) => {
      insertAtCursor(text);
      scheduleRender();
      scheduleSave();
    },
    onDraftApplied: (mode, docId) => {
      void sidebarRef?.refresh();
      if (mode === 'replace-current' && docId) void openDocById(docId);
    },
    onConvsChanged: () => void refreshNavConvs(),
  });
  initGlobalSearch();
  // Sider 智能体导航：切场景 / 新对话
  document.querySelectorAll<HTMLButtonElement>('[data-agent-scene]').forEach((b) =>
    b.addEventListener('click', () => {
      navScene = b.dataset.agentScene as 'qa' | 'writer';
      document.querySelectorAll('[data-agent-scene]').forEach((x) => x.classList.toggle('active', x === b));
      agent.setScene(navScene);
      void refreshNavConvs();
    }),
  );
  $('agent-new-nav').addEventListener('click', () => void agent.newConv(navScene));
  (window as any).__ptdocAgent = agent;

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
  // 归档页主界面：产物列表；媒体库按钮（Sider + 页头）走抽屉
  initArchivePage({
    openDoc: (id) => {
      setNav('docs');
      void openDocById(id);
    },
    showDocs: () => setNav('docs'),
  });
  initArchiveToolbar({
    // 优先用数字 id：doc_key 可能带路径分隔符（导入文件夹），数字 id 是唯一稳定的引用。
    getRef: () =>
      currentDocId != null
        ? String(currentDocId)
        : currentDocKey && !currentDocKey.includes('/')
          ? currentDocKey
          : null,
  });
  for (const btn of document.querySelectorAll('.share-media-btn, #media')) {
    btn.addEventListener('click', () => mediaPanel.toggle());
  }

  sidebarRef = initSidebar({
    onOpen: (id) => {
      void openDocById(id);
      if (isMobileLayout()) setSidebarOpen(false);
    },
    getCurrentKey: () => currentDocKey,
    onStatus: setStatus,
    onRenamed: (oldKey, newKey) => {
      if (currentDocKey === oldKey) {
        currentDocKey = newKey;
        currentFilename = newKey.slice(newKey.lastIndexOf('/') + 1);
        void refreshArchiveStatus({ force: true });
        syncChrome();
      }
      setStatus('已重命名为：' + newKey);
    },
  });

  // 删除当前文档：只在这里（文档区工具栏）提供入口，侧栏树里不再有删除按钮。
  $('doc-delete').addEventListener('click', () => {
    void deleteCurrentDoc();
  });

  void refreshDocsIndex();
  loadDefaultDoc();
});

/** 文档区工具栏的删除：二次确认 → DELETE /api/docs/:id → 回到默认文档。 */
async function deleteCurrentDoc(): Promise<void> {
  if (currentDocId == null) {
    setStatus('当前文档还没保存，无法删除', true);
    return;
  }
  const title = currentDocKey || currentFilename || '当前文档';
  const ok = await askConfirm(
    `删除「${title}」？\n仅删除工作区记录与已发布归档，不影响磁盘原文件与图床。`,
    { title: '删除文档', confirmLabel: '删除', danger: true },
  );
  if (!ok) return;
  try {
    const res = await fetch('/api/docs/' + currentDocId, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await removeHandle(currentDocKey);
    currentDocId = null;
    setStatus('已删除：' + title);
    await sidebarRef?.refresh();
    await loadDefaultDoc();
  } catch (e) {
    setStatus('删除失败：' + (e as Error).message, true);
  }
}
