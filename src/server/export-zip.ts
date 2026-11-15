import { createStoreZip } from './zip-util.ts';

/** FR-29：导出所需的文档字段（来自 listAllDocsFull，含 content 与归档 token）。 */
export interface ExportDoc {
  id: number;
  doc_key: string;
  title: string;
  updated_at: number;
  content: string;
  archive_token?: string | null;
}

// 文件名/目录名非法字符（Windows 最严，跨平台统一按它替换）：控制字符 + \ / : * ? " < > |
const ILLEGAL_SEG = /[<>:"\\|?*\u0000-\u001f]/g;

function sanitizeSegment(seg: string): string {
  const s = seg.replace(ILLEGAL_SEG, '_').trim();
  // 空段、或 . / .. 会制造越界路径，统一兜底成 _
  return s === '' || s === '.' || s === '..' ? '_' : s;
}

function ensureMd(name: string): string {
  return /\.md$/i.test(name) ? name : name + '.md';
}

/** doc_key → 导出相对路径：逐段清洗非法字符，末段补 .md。 */
export function docKeyToExportPath(docKey: string): string {
  const segs = docKey.split('/').filter((s) => s !== '');
  const out = segs.map(sanitizeSegment);
  if (!out.length) out.push('untitled');
  out[out.length - 1] = ensureMd(out[out.length - 1]);
  return out.join('/');
}

/** 同名/非法字符冲突的确定性后缀：在扩展名前插 ~<id>，仍冲突再加 -n。 */
function uniquePath(path: string, id: number, used: Set<string>): string {
  if (!used.has(path)) return path;
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  let candidate = `${stem}~${id}${ext}`;
  let n = 2;
  while (used.has(candidate)) candidate = `${stem}~${id}-${n++}${ext}`;
  return candidate;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** 表格单元格：竖线与换行会把 markdown 表格弄坏，压成空格。 */
function escapeCell(s: string): string {
  return s.replace(/[|\r\n]/g, ' ').trim();
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export interface ExportEntries {
  entries: Record<string, string>;
  /** md 文件数（= 文档数），INDEX 的数据行数应与它相等 */
  docCount: number;
}

/**
 * 把文档列表打成待压缩的条目表：每篇 md + INDEX.md + archive-urls.csv。
 * 排序与冲突后缀都是确定性的（doc_key 升序，冲突用 id），同一批输入永远得到同样结果。
 */
export function buildExportEntries(docs: ExportDoc[]): ExportEntries {
  const entries: Record<string, string> = {};
  // 预占生成文件名，避免同名用户文档被 INDEX.md / archive-urls.csv 无条件覆盖（静默丢文档）
  const used = new Set<string>(['INDEX.md', 'archive-urls.csv']);
  const rows: Array<{ title: string; path: string; updated: string; archive: string }> = [];
  const csv = ['doc_key,archive_url'];

  const sorted = [...docs].sort((a, b) =>
    a.doc_key < b.doc_key ? -1 : a.doc_key > b.doc_key ? 1 : a.id - b.id,
  );
  for (const d of sorted) {
    const path = uniquePath(docKeyToExportPath(d.doc_key), d.id, used);
    used.add(path);
    entries[path] = d.content;
    const archive = d.archive_token ? `/a/${d.archive_token}` : '';
    rows.push({ title: d.title || d.doc_key, path, updated: isoTime(d.updated_at), archive });
    if (archive) csv.push(`${csvField(d.doc_key)},${csvField(archive)}`);
  }

  const lines = ['# 文档导出索引', '', '| 标题 | 路径 | 更新时间 | 归档链接 |', '| --- | --- | --- | --- |'];
  for (const r of rows) {
    lines.push(
      `| ${escapeCell(r.title)} | ${escapeCell(r.path)} | ${escapeCell(r.updated)} | ${r.archive ? escapeCell(r.archive) : '—'} |`,
    );
  }
  entries['INDEX.md'] = lines.join('\n') + '\n';
  entries['archive-urls.csv'] = csv.join('\n') + '\n';
  return { entries, docCount: docs.length };
}

export function buildExportZip(docs: ExportDoc[]): Buffer {
  return createStoreZip(buildExportEntries(docs).entries);
}
