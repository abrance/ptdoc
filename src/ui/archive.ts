// ─── 归档（FR-17 / FR-18）──────────────────────────────────
// 归档 = 服务端把当前工作副本生成一对不可变 md/html 并发布到一个固定链接 /a/<token>。
// 前端不算 mermaid、不上传、不落库：一次 POST 拿结果；这里只管三态徽标、列表与历史折叠。

import { askConfirm, askNote } from './dialog.ts';
import { showToast } from './toast.ts';

export interface ArchiveStatus {
  stale: boolean;
  version: number;
  updated_at: number | null;
  token: string | null;
}

export interface Artifact {
  id: number;
  version: number;
  status: 'active' | 'superseded' | 'deleted';
  created_at: number;
  note: string | null;
  md_url: string | null;
  html_url: string | null;
  md_size: number | null;
  html_size: number | null;
  version_url: string | null;
}

export interface ArchiveDetail {
  token: string;
  public_url: string;
  stale: boolean;
  current: Artifact | null;
  history: Artifact[];
}

export type QdrantSyncStatus = 'none' | 'synced' | 'stale';

/** `/api/archive` 的 entries[]（归档路径树）里已有的同步状态，用来补 items[] 的徽标。 */
export interface ArchiveEntrySync {
  id: number;
  doc_key: string;
  share_id: number;
  qdrant_sync: QdrantSyncStatus;
}

export interface ArchiveItem {
  doc_id: number;
  doc_key: string;
  title: string;
  version: number;
  created_at: number;
  stale: boolean;
  token: string;
  public_url: string;
  history_count: number;
  /** 归档 Markdown 的知识库同步状态；由 entries[] 合并而来，缺失时显示「未同步」。 */
  qdrant_sync?: QdrantSyncStatus;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** public_url 是同源相对路径 /a/<token>，复制/打开都要补上 origin。 */
export function absolute(publicUrl: string): string {
  return /^https?:\/\//.test(publicUrl) ? publicUrl : location.origin + publicUrl;
}

/**
 * 归档预览地址：永远走 /a/<token>（服务端现签现渲染）。
 * 不能用 entries[].html_url：那是对象存储地址，私有桶下是随时过期的临时签名。
 */
export function previewUrl(item: { public_url?: string | null; token?: string | null }): string {
  const rel = item.public_url || (item.token ? '/a/' + item.token : '');
  return rel ? absolute(rel) : '';
}

/**
 * 把 entries[] 里的 qdrant_sync 合并进 items[] 行。
 * 后端两个数组并存：items 供列表、entries 供归档树；entries.id 与 items.doc_id 都是文档 id。
 * items 自身若已带 qdrant_sync（后端后续补齐），以 items 为准。
 */
export function mergeArchiveEntries(
  items: ArchiveItem[],
  entries: ArchiveEntrySync[] | undefined,
): ArchiveItem[] {
  if (!entries || entries.length === 0) return items;
  const byKey = new Map<string, ArchiveEntrySync>(entries.map((e) => [e.doc_key, e]));
  const byId = new Map<number, ArchiveEntrySync>(entries.map((e) => [e.id, e]));
  return items.map((it) => {
    if (it.qdrant_sync) return it;
    const e = byKey.get(it.doc_key) ?? byId.get(it.doc_id);
    return e?.qdrant_sync ? { ...it, qdrant_sync: e.qdrant_sync } : it;
  });
}

/** created_at 兼容秒 / 毫秒两种存法，统一按本地时区展示到分钟。 */
function fmtTime(ts: number): string {
  if (!ts) return '—';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtBytes(n: number | null): string {
  if (!n) return '';
  return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
}

async function readJson<T>(res: Response): Promise<T & { error?: string; step?: string }> {
  try {
    return (await res.json()) as T & { error?: string; step?: string };
  } catch {
    return {} as T & { error?: string; step?: string };
  }
}

/** 归档失败落哪一步 → 给用户看的中文名。服务端在 error 响应里带 step。 */
const STEP_LABEL: Record<string, string> = {
  render: 'mermaid 图表渲染',
  upload: '对象存储上传',
  db: '归档记录写库',
};

function stepLabel(step?: string): string {
  if (!step) return '';
  return STEP_LABEL[step] ?? step;
}

/** 把 {error, step} 拼成一条能直接放进提示的文案：先阶段后原因，缺什么都退回状态码。 */
export function archiveErrorText(
  data: { error?: string; step?: string },
  status?: number,
): string {
  const at = stepLabel(data.step);
  const msg = data.error || (status ? 'HTTP ' + status : '');
  return at ? `${at} 阶段：${msg}` : msg;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 文档失焦 / 非安全上下文时 Clipboard API 会被拒，退回 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    if (!ok) {
      showToast('复制失败：剪贴板被拒绝，请手动复制 ' + text, 'error');
      return;
    }
  }
  showToast('已复制链接：' + text, 'success');
}

// ─── 文档页工具条：三态徽标 + 归档 / 重新归档 / 复制链接 ──────────
let toolbarStatus: ArchiveStatus = { stale: false, version: -1, updated_at: null, token: null };

/** 切换到另一篇文档时调用：上一个 version 不能当作本篇的已知状态。 */
export function markArchiveStatusUnknown(): void {
  statusSeq++;
  toolbarStatus = { stale: false, version: -1, updated_at: null, token: null };
  paintToolbar();
}
let statusSeq = 0;
let busy = false;
let getRef: () => string | null = () => null;

function paintToolbar(): void {
  const state = $('archive-state');
  const btn = $('archive') as HTMLButtonElement;
  const copy = $('archive-copy') as HTMLButtonElement;
  const v = toolbarStatus.version;
  if (v <= 0) {
    state.textContent = '未归档';
    state.className = 'archive-state';
    btn.textContent = '归档';
    btn.classList.add('btn-primary');
    copy.hidden = true;
    return;
  }
  state.textContent = toolbarStatus.stale ? '暂存区有更新' : '已归档 v' + v;
  state.className = 'archive-state ' + (toolbarStatus.stale ? 'is-stale' : 'is-archived');
  btn.textContent = '重新归档';
  btn.classList.remove('btn-primary');
  copy.hidden = !toolbarStatus.token;
}

function setBusy(on: boolean): void {
  busy = on;
  const btn = $('archive') as HTMLButtonElement;
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
  if (on) btn.textContent = '归档中…';
  else paintToolbar();
}

/**
 * 刷新当前文档的归档状态。
 * version === 0 表示确定未归档过，继续编辑不会改变状态，所以非强制调用直接跳过；
 * version === -1 表示当前文档状态未知（刚切换过来），必须查一次。
 */
export async function refreshArchiveStatus(opts?: { force?: boolean }): Promise<void> {
  const ref = getRef();
  if (!ref) return;
  if (!opts?.force && toolbarStatus.version === 0) return;
  const seq = ++statusSeq;
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(ref)}/archive-status`);
    const data = await readJson<ArchiveStatus>(res);
    if (seq !== statusSeq) return;
    if (!res.ok) return; // 文档还没落库（404）等：保持当前显示
    toolbarStatus = {
      stale: Boolean(data.stale),
      version: Number(data.version) || 0,
      updated_at: data.updated_at ?? null,
      token: data.token ?? null,
    };
    paintToolbar();
  } catch {
    /* 离线静默：徽标不是关键路径 */
  }
}

/** 当前文档归档后立刻把状态拉准（服务端返回的就是真值，但 stale/token 以状态接口为准）。 */
function applyStatus(patch: Partial<ArchiveStatus>): void {
  toolbarStatus = { ...toolbarStatus, ...patch };
  paintToolbar();
}

type WarnKind = 'sign' | 'missing' | 'other';

const WARN_TAG: Record<WarnKind, string> = { sign: '签名失效 401', missing: '不存在 404', other: '不可访问' };

/** 服务端告警文案已带状态码（FR-26），这里只分类展示，不重算。 */
function warnKind(w: string): WarnKind {
  if (/（HTTP 40[13]）/.test(w)) return 'sign';
  if (/（HTTP 404）/.test(w)) return 'missing';
  return 'other';
}

function warnSummary(warnings: string[]): string {
  const count: Record<WarnKind, number> = { sign: 0, missing: 0, other: 0 };
  for (const w of warnings) count[warnKind(w)]++;
  const parts: string[] = [];
  if (count.sign) parts.push(`${count.sign} 张图签名失效(401)`);
  if (count.missing) parts.push(`${count.missing} 张图不存在(404)`);
  if (count.other) parts.push(`${count.other} 张图不可访问`);
  return parts.join('，');
}

function showResultLink(publicUrl: string, warnings: string[] = []): void {
  const box = $('archive-result');
  const url = absolute(publicUrl);
  ($('archive-result-url') as HTMLElement).textContent = url;
  box.dataset.url = url;
  const list = $('archive-result-warnings');
  list.innerHTML = warnings
    .map((w) => {
      const kind = warnKind(w);
      return `<li><span class="archive-warn-tag is-${kind}">${WARN_TAG[kind]}</span><span>${esc(w)}</span></li>`;
    })
    .join('');
  list.hidden = warnings.length === 0;
  box.hidden = false;
  clearTimeout(resultTimer);
  resultTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 15000);
}
let resultTimer: number | undefined;

async function runArchive(ref: string): Promise<void> {
  const first = toolbarStatus.version <= 0;
  const note = await askNote({
    title: first ? '归档这篇文档？' : '重新归档这篇文档？',
    message: first
      ? '会把当前内容生成一对固定的 md / html 文件，并发布到一个免登录可打开的链接。之后再次归档，链接不变、内容更新。'
      : `会生成 v${toolbarStatus.version + 1}，链接不变、内容更新；v${toolbarStatus.version} 会进入历史。`,
    label: '备注（可留空）',
    placeholder: '例如：给外部同学看的版本',
    confirmLabel: first ? '归档' : '重新归档',
  });
  if (note === null) return;
  await archiveWithRetry(ref, note);
}

/** 真正发归档请求；失败时给一条带「重试」的提示，并说明断在哪一步。
 *
 * 以前只剩一句「归档失败：...」飘走，用户唯一能做的就是再点一次同一个按钮，
 * 而且不知道失败是图渲染、上传还是写库——重试前无从判断。
 */
async function archiveWithRetry(ref: string, note: string): Promise<void> {
  setBusy(true);
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(ref)}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    const data = await readJson<{
      id: number;
      version: number;
      token: string;
      public_url: string;
      unchanged?: boolean;
      image_warnings?: string[];
    }>(res);
    if (!res.ok) throw new Error(archiveErrorText(data, res.status));
    const warnings = data.image_warnings ?? [];
    applyStatus({ stale: false, version: Number(data.version) || toolbarStatus.version + 1, token: data.token ?? null });
    showResultLink(data.public_url, warnings);
    const warn = warnings.length ? `；${warnSummary(warnings)}` : '';
    showToast(
      (data.unchanged ? `内容未变化，已生成 v${data.version}` : `已归档 v${data.version}`) + warn,
      warnings.length ? 'error' : data.unchanged ? 'info' : 'success',
    );
    void refreshArchiveList();
  } catch (e) {
    // 重试按钮直接再跑这一遍（note 沿用，不用重新填备注）。
    showToast('归档失败：' + (e as Error).message, 'error', {
      label: '重试',
      onClick: () => void archiveWithRetry(ref, note),
    });
  } finally {
    setBusy(false);
  }
}

async function copyCurrentLink(): Promise<void> {
  const ref = getRef();
  if (!ref) return;
  if (toolbarStatus.token) {
    await copyText(absolute('/a/' + toolbarStatus.token));
    return;
  }
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(ref)}/archive`);
    const data = await readJson<ArchiveDetail>(res);
    if (!res.ok || !data.public_url) throw new Error((data.error as string) || 'HTTP ' + res.status);
    await copyText(absolute(data.public_url));
  } catch (e) {
    showToast('复制链接失败：' + (e as Error).message, 'error');
  }
}

export function initArchiveToolbar(opts: { getRef: () => string | null }): void {
  getRef = opts.getRef;
  paintToolbar();
  $('archive').addEventListener('click', () => {
    const ref = getRef();
    if (!ref) {
      showToast('请先打开或保存一篇文档', 'error');
      return;
    }
    if (busy) return;
    void runArchive(ref);
  });
  $('archive-copy').addEventListener('click', () => void copyCurrentLink());
  $('archive-result-copy').addEventListener('click', () => {
    const url = $('archive-result').dataset.url;
    if (url) void copyText(url);
  });
  $('archive-result-close').addEventListener('click', () => {
    $('archive-result').hidden = true;
  });
}

// ─── 「归档」列表页 ──────────────────────────────────────
interface PageOpts {
  openDoc: (docId: number) => void;
  showDocs: () => void;
}

let pageOpts: PageOpts = { openDoc: () => {}, showDocs: () => {} };
let listSeq = 0;
let searchTimer: number | undefined;

function statusCell(item: { stale: boolean; version: number }): string {
  if (item.stale)
    return '<span class="ar-stale" title="草稿已改，尚未重新生成分享版">有更新未归档</span>';
  return '<span class="ar-status is-archived">已归档</span>';
}

const QDRANT_LABEL: Record<QdrantSyncStatus, string> = {
  none: '未同步',
  stale: '待同步',
  synced: '已同步',
};

const QDRANT_TITLE: Record<QdrantSyncStatus, string> = {
  none: '尚未写入知识库',
  stale: '归档已更新，知识库仍是旧版',
  synced: '归档 Markdown 已写入知识库',
};

/** 知识库三态徽标（none / stale / synced）；entries 里查不到状态时回落「未同步」。 */
export function qdrantBadgeHtml(status?: QdrantSyncStatus): string {
  const s: QdrantSyncStatus = status ?? 'none';
  return `<span class="ar-qdrant ar-qdrant-${s}" title="${QDRANT_TITLE[s]}">${QDRANT_LABEL[s]}</span>`;
}

/** 归档列表行操作：预览已发布页、同步知识库（原侧栏归档入口迁入）。 */
export function archiveOpsHtml(item: ArchiveItem): string {
  const history = `历史${item.history_count ? ' (' + item.history_count + ')' : ''}`;
  return `<span class="ar-ops">
      <button data-op="open" type="button" title="打开源文档编辑">编辑原稿</button>
      <button data-op="preview" type="button">预览</button>
      <button data-op="copy" type="button">复制链接</button>
      <button data-op="history" type="button" aria-expanded="false" data-label="${history}">${history}</button>
      <button data-op="sync" type="button" class="ar-qdrant-btn" title="把归档 Markdown 同步到知识库">同步知识库</button>
      <button data-op="archive" type="button">重新归档</button>
      <button data-op="purge" type="button" class="is-danger">删除</button>
    </span>`;
}

export async function refreshArchiveList(q = ''): Promise<void> {
  const list = $('archive-list');
  const seq = ++listSeq;
  if (!list.dataset.rendered) list.innerHTML = '<li class="ar-empty">加载中…</li>';
  try {
    const url = '/api/archive' + (q ? '?q=' + encodeURIComponent(q) : '');
    const res = await fetch(url);
    const data = await readJson<{ items: ArchiveItem[]; entries?: ArchiveEntrySync[] }>(res);
    if (seq !== listSeq) return;
    if (!res.ok) throw new Error((data.error as string) || 'HTTP ' + res.status);
    const items = mergeArchiveEntries(data.items ?? [], data.entries);
    list.dataset.rendered = '1';
    if (items.length === 0) {
      list.innerHTML = q
        ? `<li class="ar-empty">没有匹配「${esc(q)}」的归档。</li>`
        : `<li class="ar-empty">还没有归档产物。打开任意文档点「归档」即可。
             <button data-op="docs" type="button">打开文档列表</button></li>`;
      return;
    }
    list.innerHTML = items
      .map(
        (it) => `<li class="ar-row" data-id="${it.doc_id}" data-key="${esc(it.doc_key || '')}" data-token="${esc(
          it.token || '',
        )}" data-public-url="${esc(it.public_url || (it.token ? '/a/' + it.token : ''))}">
          <div class="ar-line">
            <span class="ar-title" title="${esc(it.title || it.doc_key)}">${esc(it.title || '未命名文档')}</span>
            <span class="ar-ver">v${it.version}</span>
            ${statusCell(it)}
            ${qdrantBadgeHtml(it.qdrant_sync)}
            <span class="ar-time">${fmtTime(it.created_at)}</span>
            ${archiveOpsHtml(it)}
          </div>
          <ul class="ar-history" hidden></ul>
        </li>`,
      )
      .join('');
  } catch (e) {
    if (seq !== listSeq) return;
    list.dataset.rendered = '1';
    list.innerHTML = `<li class="ar-empty">加载失败：${esc((e as Error).message)}</li>`;
  }
}

function artifactUrl(item: Artifact, token: string, base: string, v: number): string {
  return absolute(item.version_url || base.replace(/\/$/, '') + '/v/' + v);
}

async function paintHistory(row: HTMLElement, docId: number, token: string): Promise<void> {
  const box = row.querySelector('.ar-history') as HTMLElement;
  box.innerHTML = '<li class="ar-h-empty">加载中…</li>';
  try {
    const res = await fetch(`/api/docs/${docId}/archive`);
    const data = await readJson<ArchiveDetail>(res);
    if (!res.ok) throw new Error((data.error as string) || 'HTTP ' + res.status);
    const base = data.public_url || '/a/' + (data.token || token);
    const rows = (data.history ?? []).filter((a) => a.status !== 'deleted');
    if (rows.length === 0) {
      box.innerHTML = '<li class="ar-h-empty">没有旧产物，当前只有 1 个版本。</li>';
      return;
    }
    box.innerHTML = rows
      .map(
        (a) => `<li class="ar-h-row" data-art="${a.id}" data-version="${a.version}" data-url="${esc(
          artifactUrl(a, token, base, a.version),
        )}" data-md="${esc(a.md_url || '')}">
          <span class="ar-h-ver">v${a.version}</span>
          <span class="ar-h-time">${fmtTime(a.created_at)}</span>
          <span class="ar-h-note">${esc(a.note || '')}${a.md_size ? ' · ' + fmtBytes(a.md_size) : ''}</span>
          <span class="ar-ops">
            <button data-op="preview" type="button">预览</button>
            <button data-op="download" type="button">下载 MD</button>
            <button data-op="purge" type="button" class="is-danger">彻底删除</button>
          </span>
        </li>`,
      )
      .join('');
  } catch (e) {
    box.innerHTML = `<li class="ar-h-empty">加载失败：${esc((e as Error).message)}</li>`;
  }
}

async function reArchive(ref: string): Promise<void> {
  const note = await askNote({
    title: '重新归档？',
    message: '会用这篇文档当前保存的内容生成新版本，链接不变；旧版本进入历史。',
    label: '备注（可留空）',
    confirmLabel: '重新归档',
  });
  if (note === null) return;
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(ref)}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    const data = await readJson<{ version: number; unchanged?: boolean; image_warnings?: string[] }>(res);
    if (!res.ok) throw new Error((data.error as string) || 'HTTP ' + res.status);
    const warnings = data.image_warnings ?? [];
    showToast(
      (data.unchanged ? `内容未变化，已生成 v${data.version}` : `已归档 v${data.version}`) +
        (warnings.length ? `；${warnSummary(warnings)}` : ''),
      warnings.length ? 'error' : data.unchanged ? 'info' : 'success',
    );
    const cur = getRef();
    if (cur && cur === ref) void refreshArchiveStatus({ force: true });
    void refreshArchiveList(($('archive-search') as HTMLInputElement).value.trim());
  } catch (e) {
    showToast('归档失败：' + (e as Error).message, 'error');
  }
}

async function purgeArtifact(id: number, version: number): Promise<void> {
  const ok = await askConfirm(
    '会同时删除对象存储中的 md / html 文件，删除后无法恢复。此操作不可撤销。',
    { title: `彻底删除 v${version}？`, confirmLabel: '彻底删除', danger: true },
  );
  if (!ok) return;
  try {
    const res = await fetch(`/api/share/${id}?purge=1`, { method: 'DELETE' });
    const data = await readJson<{ ok: boolean }>(res);
    if (!res.ok) throw new Error((data.error as string) || 'HTTP ' + res.status);
    showToast(`已彻底删除 v${version}`, 'success');
    void refreshArchiveList(($('archive-search') as HTMLInputElement).value.trim());
    void refreshArchiveStatus({ force: true });
  } catch (e) {
    showToast('删除失败：' + (e as Error).message, 'error');
  }
}

/** 删掉当前生效的归档：文档回到未归档，列表行消失。 */
async function purgeActive(docId: number, docKey: string): Promise<void> {
  let current: Artifact | null = null;
  try {
    const res = await fetch(`/api/docs/${docId}/archive`);
    const data = await readJson<ArchiveDetail>(res);
    if (!res.ok) throw new Error((data.error as string) || 'HTTP ' + res.status);
    current = data.current;
  } catch (e) {
    showToast('读取归档失败：' + (e as Error).message, 'error');
    return;
  }
  if (!current) {
    void refreshArchiveList(($('archive-search') as HTMLInputElement).value.trim());
    return;
  }
  const ok = await askConfirm(
    '会同时删除对象存储中的 md / html 文件，删除后无法恢复，公开链接立刻失效；此文档回到「未归档」。',
    { title: `彻底删除 v${current.version}？`, confirmLabel: '彻底删除', danger: true },
  );
  if (!ok) return;
  try {
    const res = await fetch(`/api/share/${current.id}?purge=1`, { method: 'DELETE' });
    const data = await readJson<{ ok: boolean }>(res);
    if (!res.ok) throw new Error((data.error as string) || 'HTTP ' + res.status);
    showToast('已彻底删除归档', 'success');
    // 当前打开的很可能就是这篇，直接强制刷新一次徽标
    void refreshArchiveStatus({ force: true });
    void refreshArchiveList(($('archive-search') as HTMLInputElement).value.trim());
  } catch (e) {
    showToast('删除失败：' + (e as Error).message, 'error');
  }
}

/** 把当前归档 Markdown 写入知识库；成功后刷新徽标。 */
async function syncArchive(docId: number): Promise<void> {
  try {
    const res = await fetch(`/api/docs/${docId}/qdrant-sync`, { method: 'POST' });
    const data = await readJson<{ chunks?: number }>(res);
    if (!res.ok) throw new Error((data.error as string) || 'HTTP ' + res.status);
    showToast(`已同步到知识库（${data.chunks ?? 0} 段）`, 'success');
    void refreshArchiveList(($('archive-search') as HTMLInputElement).value.trim());
  } catch (e) {
    showToast('同步失败：' + (e as Error).message, 'error');
  }
}

export function initArchivePage(opts: PageOpts): void {
  pageOpts = opts;
  const list = $('archive-list');
  const input = $('archive-search') as HTMLInputElement;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void refreshArchiveList(input.value.trim()), 300);
  });
  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
    if (!btn) return;
    const op = btn.dataset.op;
    const row = btn.closest<HTMLElement>('.ar-row');
    const hRow = btn.closest<HTMLElement>('.ar-h-row');
    if (op === 'docs') {
      pageOpts.showDocs();
      return;
    }
    if (hRow && row) {
      const id = Number(hRow.dataset.art);
      const version = Number(hRow.dataset.version);
      if (op === 'preview') window.open(hRow.dataset.url, '_blank', 'noopener');
      else if (op === 'download' && hRow.dataset.md) {
        const a = document.createElement('a');
        a.href = hRow.dataset.md;
        a.download = '';
        a.target = '_blank';
        a.rel = 'noopener';
        a.click();
      } else if (op === 'purge') void purgeArtifact(id, version);
      return;
    }
    if (!row) return;
    const docId = Number(row.dataset.id);
    const docKey = row.dataset.key || '';
    if (op === 'open') pageOpts.openDoc(docId);
    else if (op === 'preview') {
      const url = previewUrl({ public_url: row.dataset.publicUrl, token: row.dataset.token });
      if (url) window.open(url, '_blank', 'noopener');
      else showToast('没有可预览的归档链接', 'error');
    } else if (op === 'copy') void copyText(absolute(row.dataset.token ? '/a/' + row.dataset.token : ''));
    else if (op === 'sync') void syncArchive(docId);
    else if (op === 'archive') void reArchive(String(docId));
    else if (op === 'purge') void purgeActive(docId, docKey);
    else if (op === 'history') {
      const box = row.querySelector('.ar-history') as HTMLElement;
      const open = box.hidden;
      box.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? '收起历史' : btn.dataset.label || '历史';
      if (open) void paintHistory(row, docId, row.dataset.token || '');
    }
  });
}
