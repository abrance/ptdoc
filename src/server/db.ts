import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let db: DatabaseSync | null = null;

/** 初始化 SQLite（库文件落在项目根 data/ptdoc.db）。重复调用安全。 */
export function initDB(): void {
  if (db) return;
  const dir = join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'ptdoc.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_key     TEXT UNIQUE NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      filename    TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS shares (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_key    TEXT,
      share_md   TEXT NOT NULL,
      md_url     TEXT,
      html_url   TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id     INTEGER NOT NULL,
      qiniu_key    TEXT NOT NULL,
      url          TEXT NOT NULL,
      mermaid_hash TEXT,
      created_at   INTEGER NOT NULL,
      FOREIGN KEY (share_id) REFERENCES shares(id)
    );
    CREATE TABLE IF NOT EXISTS mermaid_cache (
      mermaid_hash TEXT PRIMARY KEY,
      qiniu_key    TEXT NOT NULL,
      url          TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc_versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id     INTEGER NOT NULL REFERENCES docs(id),
      content    TEXT NOT NULL,
      label      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      qiniu_key  TEXT NOT NULL,
      url        TEXT NOT NULL,
      filename   TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'direct',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shares_doc   ON shares(doc_key);
    CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(doc_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC);
  `);
  // 兼容已有数据库：补充"最近打开时间"列
  try {
    db.exec('ALTER TABLE docs ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* 列已存在则忽略 */
  }
  // 兼容已有数据库：补充"分享版 HTML 永久链接"列
  try {
    db.exec('ALTER TABLE shares ADD COLUMN html_url TEXT');
  } catch {
    /* 列已存在则忽略 */
  }
  // 兼容已有数据库：补充"分享版 .md 文件永久链接"列
  try {
    db.exec('ALTER TABLE shares ADD COLUMN md_url TEXT');
  } catch {
    /* 列已存在则忽略 */
  }
}

interface DocRow {
  id: number;
  doc_key: string;
  title: string;
  filename: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface DocSummary {
  id: number;
  doc_key: string;
  title: string;
  filename: string;
  updated_at: number;
  last_opened_at: number;
}

/** 按 doc_key 新增或更新一篇文档（全文 + 元信息）。 */
export function upsertDoc(
  docKey: string,
  title: string,
  filename: string,
  content: string,
): { id: number; doc_key: string } {
  const now = Date.now();
  const existing = db!.prepare('SELECT id, created_at FROM docs WHERE doc_key=?').get(docKey) as
    unknown as { id: number; created_at: number } | undefined;
  if (existing) {
    db!.prepare(
      'UPDATE docs SET title=?, filename=?, content=?, updated_at=?, last_opened_at=? WHERE doc_key=?',
    ).run(title, filename, content, now, now, docKey);
    return { id: existing.id, doc_key: docKey };
  }
  const info = db!
    .prepare(
      'INSERT INTO docs (doc_key, title, filename, content, created_at, updated_at, last_opened_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(docKey, title, filename, content, now, now, now);
  return { id: Number(info.lastInsertRowid), doc_key: docKey };
}

export function getDoc(id: number): DocRow | undefined {
  return db!.prepare('SELECT * FROM docs WHERE id=?').get(id) as unknown as DocRow | undefined;
}

export function searchDocs(q: string, limit = 50): DocSummary[] {
  const like = `%${q}%`;
  return db!
    .prepare(
      `SELECT id, doc_key, title, filename, updated_at, last_opened_at FROM docs
       WHERE title LIKE ? OR filename LIKE ? OR content LIKE ?
       ORDER BY last_opened_at DESC, updated_at DESC LIMIT ?`,
    )
    .all(like, like, like, limit) as unknown as DocSummary[];
}

export function listRecent(limit = 50): DocSummary[] {
  return db!
    .prepare(
      'SELECT id, doc_key, title, filename, updated_at, last_opened_at FROM docs ORDER BY last_opened_at DESC, updated_at DESC LIMIT ?',
    )
    .all(limit) as unknown as DocSummary[];
}

/** 全部文档（按 doc_key 排序），供侧边栏文档树构建。 */
export function listAllDocs(): DocSummary[] {
  return db!
    .prepare(
      'SELECT id, doc_key, title, filename, updated_at, last_opened_at FROM docs ORDER BY doc_key ASC',
    )
    .all() as unknown as DocSummary[];
}

/** 全部文档全文（含 content），供前端全文搜索索引构建。 */
export function listAllDocsFull(): Array<DocRow & DocSummary> {
  return db!.prepare('SELECT * FROM docs ORDER BY doc_key ASC').all() as unknown as Array<
    DocRow & DocSummary
  >;
}

/** 重命名文档：更新 doc_key 并级联更新该文档的 shares 引用（同一事务）。 */
export function renameDoc(id: number, newKey: string): { ok: boolean } {
  const row = db!.prepare('SELECT doc_key FROM docs WHERE id=?').get(id) as
    | { doc_key: string }
    | undefined;
  if (!row) throw new Error('文档不存在');
  db!.exec('BEGIN');
  try {
    db!.prepare('UPDATE docs SET doc_key=?, updated_at=? WHERE id=?').run(newKey, Date.now(), id);
    if (row.doc_key !== newKey) {
      db!.prepare('UPDATE shares SET doc_key=? WHERE doc_key=?').run(newKey, row.doc_key);
    }
    db!.exec('COMMIT');
  } catch (e) {
    db!.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

/** 删除文档记录：级联删除其分享记录、分享图片映射与版本快照（同一事务）。 */
export function deleteDoc(id: number): { ok: boolean } {
  const row = db!.prepare('SELECT doc_key FROM docs WHERE id=?').get(id) as
    | { doc_key: string }
    | undefined;
  if (!row) throw new Error('文档不存在');
  db!.exec('BEGIN');
  try {
    const shareIds = (
      db!.prepare('SELECT id FROM shares WHERE doc_key=?').all(row.doc_key) as Array<{ id: number }>
    ).map((r) => r.id);
    for (const sid of shareIds) db!.prepare('DELETE FROM images WHERE share_id=?').run(sid);
    db!.prepare('DELETE FROM shares WHERE doc_key=?').run(row.doc_key);
    db!.prepare('DELETE FROM doc_versions WHERE doc_id=?').run(id);
    db!.prepare('DELETE FROM docs WHERE id=?').run(id);
    db!.exec('COMMIT');
  } catch (e) {
    db!.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

// ─── 版本快照（doc_versions）────────────────────────────
export interface SnapshotRow {
  id: number;
  doc_id: number;
  content: string;
  label: string | null;
  created_at: number;
}

/** 基于文档当前内容生成一条不可变快照（可带标签）。 */
export function createSnapshot(docId: number, label?: string): { id: number } {
  const doc = getDoc(docId);
  if (!doc) throw new Error('文档不存在');
  const info = db!
    .prepare(
      'INSERT INTO doc_versions (doc_id, content, label, created_at) VALUES (?,?,?,?)',
    )
    .run(docId, doc.content, label?.trim() || null, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

export function listSnapshots(docId: number): SnapshotRow[] {
  return db!
    .prepare('SELECT * FROM doc_versions WHERE doc_id=? ORDER BY created_at DESC, id DESC')
    .all(docId) as unknown as SnapshotRow[];
}

/** 把快照内容写回文档当前工作副本（docs.content），不生成新快照。 */
export function restoreSnapshot(docId: number, snapshotId: number): { ok: boolean } {
  const snap = db!
    .prepare('SELECT content FROM doc_versions WHERE id=? AND doc_id=?')
    .get(snapshotId, docId) as { content: string } | undefined;
  if (!snap) throw new Error('快照不存在');
  db!.prepare('UPDATE docs SET content=?, updated_at=? WHERE id=?').run(snap.content, Date.now(), docId);
  return { ok: true };
}

export function deleteSnapshot(snapshotId: number): { ok: boolean } {
  const r = db!.prepare('DELETE FROM doc_versions WHERE id=?').run(snapshotId);
  if (Number(r.changes) === 0) throw new Error('快照不存在');
  return { ok: true };
}

// ─── 媒体库（media）─────────────────────────────────────
export interface MediaRow {
  id: number;
  qiniu_key: string;
  url: string;
  filename: string;
  source: 'direct' | 'mermaid';
  size: number;
  created_at: number;
}

/** 记录一次图床上传（直接上传 source='direct'，分享版 mermaid 图 source='mermaid'）。 */
export function insertMedia(
  qiniuKey: string,
  url: string,
  filename: string,
  source: string,
  size: number,
): { id: number } {
  const info = db!
    .prepare(
      'INSERT INTO media (qiniu_key, url, filename, source, size, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(qiniuKey, url, filename, source === 'mermaid' ? 'mermaid' : 'direct', size, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

export function listMedia(q?: string, source?: string): MediaRow[] {
  const conds: string[] = [];
  const args: Array<string> = [];
  if (source === 'direct' || source === 'mermaid') {
    conds.push('source=?');
    args.push(source);
  }
  if (q) {
    conds.push('(filename LIKE ? OR url LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db!
    .prepare(`SELECT * FROM media ${where} ORDER BY created_at DESC LIMIT 500`)
    .all(...args) as unknown as MediaRow[];
}

/** 取单条媒体记录（删除前校验存在性）。 */
export function getMedia(id: number): MediaRow | undefined {
  return db!.prepare('SELECT * FROM media WHERE id=?').get(id) as unknown as MediaRow | undefined;
}

export function deleteMediaRecord(id: number): void {
  db!.prepare('DELETE FROM media WHERE id=?').run(id);
}

export interface ShareImage {
  qiniu_key: string;
  url: string;
  mermaid_hash?: string;
}

/** 记录一次分享版生成：保存分享 md 文本 + 其包含的每张图片映射 + 已上传的 .md/.html 永久链接。 */
export function insertShare(
  docKey: string | null,
  shareMd: string,
  images: ShareImage[],
  mdUrl?: string,
  htmlUrl?: string,
): { id: number } {
  const now = Date.now();
  const info = db!
    .prepare('INSERT INTO shares (doc_key, share_md, md_url, html_url, created_at) VALUES (?,?,?,?,?)')
    .run(docKey, shareMd, mdUrl ?? null, htmlUrl ?? null, now);
  const shareId = Number(info.lastInsertRowid);
  const stmt = db!.prepare(
    'INSERT INTO images (share_id, qiniu_key, url, mermaid_hash, created_at) VALUES (?,?,?,?,?)',
  );
  for (const im of images) {
    stmt.run(shareId, im.qiniu_key, im.url, im.mermaid_hash ?? null, now);
  }
  return { id: shareId };
}

export interface ShareRow {
  id: number;
  doc_key: string | null;
  md_url: string | null;
  html_url: string | null;
  created_at: number;
}

/** 取单条分享记录（含 share_md，用于托管页 /s/:id 渲染与「查看 MD」）。 */
export function getShare(
  id: number,
): { id: number; doc_key: string | null; share_md: string; md_url: string | null; html_url: string | null } | undefined {
  return db!.prepare('SELECT id, doc_key, share_md, md_url, html_url FROM shares WHERE id=?').get(id) as
    | { id: number; doc_key: string | null; share_md: string; md_url: string | null; html_url: string | null }
    | undefined;
}

/** 删除分享记录及其图片映射（不影响七牛上已上传的 HTML/图片）。 */
export function deleteShare(id: number): { ok: boolean } {
  db!.exec('BEGIN');
  try {
    db!.prepare('DELETE FROM images WHERE share_id=?').run(id);
    const r = db!.prepare('DELETE FROM shares WHERE id=?').run(id);
    if (Number(r.changes) === 0) throw new Error('分享记录不存在');
    db!.exec('COMMIT');
  } catch (e) {
    db!.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

export function listShares(docKey?: string): ShareRow[] {
  if (docKey) {
    return db!
      .prepare('SELECT id, doc_key, md_url, html_url, created_at FROM shares WHERE doc_key=? ORDER BY created_at DESC')
      .all(docKey) as unknown as ShareRow[];
  }
  return db!
    .prepare('SELECT id, doc_key, md_url, html_url, created_at FROM shares ORDER BY created_at DESC')
    .all() as unknown as ShareRow[];
}

/** 上传分享版 HTML 成功后，把永久公开链接回写对应分享记录。 */
export function updateShareHtmlUrl(shareId: number, htmlUrl: string): void {
  db!.prepare('UPDATE shares SET html_url=? WHERE id=?').run(htmlUrl, shareId);
}

/** 取分享记录的图片映射（按发布顺序），供前端做"当前文档 vs 上次发布"一致性检查。 */
export function listShareImages(shareId: number): ShareImage[] {
  return db!
    .prepare('SELECT qiniu_key, url, mermaid_hash FROM images WHERE share_id=? ORDER BY id ASC')
    .all(shareId) as unknown as ShareImage[];
}

// ─── mermaid -> 已上传图片 的全局缓存（按内容哈希去重）──
export function getMermaidCache(): Record<string, string> {
  const rows = db!
    .prepare('SELECT mermaid_hash, url FROM mermaid_cache')
    .all() as unknown as Array<{ mermaid_hash: string; url: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.mermaid_hash] = r.url;
  return map;
}

export function putMermaidCache(hash: string, key: string, url: string): void {
  const now = Date.now();
  db!
    .prepare(
      'INSERT OR REPLACE INTO mermaid_cache (mermaid_hash, qiniu_key, url, created_at) VALUES (?,?,?,?)',
    )
    .run(hash, key, url, now);
}
