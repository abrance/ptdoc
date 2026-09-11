import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError } from './http.ts';

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

function tableHasColumn(table: string, column: string): boolean {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function recreateDocsTable(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE docs_mu (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL DEFAULT 0,
      doc_key     TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      filename    TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, doc_key)
    );
  `);
  if (tableHasColumn('docs', 'user_id')) {
    d.exec(`
      INSERT INTO docs_mu (id, user_id, doc_key, title, filename, content, created_at, updated_at, last_opened_at)
      SELECT id, user_id, doc_key, title, filename, content, created_at, updated_at, last_opened_at FROM docs;
    `);
  } else {
    d.exec(`
      INSERT INTO docs_mu (id, user_id, doc_key, title, filename, content, created_at, updated_at, last_opened_at)
      SELECT id, 0, doc_key, title, filename, content, created_at, updated_at, last_opened_at FROM docs;
    `);
  }
  d.exec('DROP TABLE docs');
  d.exec('ALTER TABLE docs_mu RENAME TO docs');
  d.exec('CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_docs_user ON docs(user_id)');
}

function recreateSharesTable(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE shares_mu (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 0,
      doc_key    TEXT,
      share_md   TEXT NOT NULL,
      md_url     TEXT,
      html_url   TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  if (tableHasColumn('shares', 'user_id')) {
    d.exec(`
      INSERT INTO shares_mu (id, user_id, doc_key, share_md, md_url, html_url, created_at)
      SELECT id, user_id, doc_key, share_md, md_url, html_url, created_at FROM shares;
    `);
  } else {
    d.exec(`
      INSERT INTO shares_mu (id, user_id, doc_key, share_md, md_url, html_url, created_at)
      SELECT id, 0, doc_key, share_md, md_url, html_url, created_at FROM shares;
    `);
  }
  d.exec('DROP TABLE shares');
  d.exec('ALTER TABLE shares_mu RENAME TO shares');
  d.exec('CREATE INDEX IF NOT EXISTS idx_shares_doc ON shares(user_id, doc_key)');
}

function recreateMediaTable(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE media_mu (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 0,
      qiniu_key  TEXT NOT NULL,
      url        TEXT NOT NULL,
      filename   TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'direct',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  if (tableHasColumn('media', 'user_id')) {
    d.exec(`
      INSERT INTO media_mu (id, user_id, qiniu_key, url, filename, source, size, created_at)
      SELECT id, user_id, qiniu_key, url, filename, source, size, created_at FROM media;
    `);
  } else {
    d.exec(`
      INSERT INTO media_mu (id, user_id, qiniu_key, url, filename, source, size, created_at)
      SELECT id, 0, qiniu_key, url, filename, source, size, created_at FROM media;
    `);
  }
  d.exec('DROP TABLE media');
  d.exec('ALTER TABLE media_mu RENAME TO media');
  d.exec('CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id)');
}

function recreateMermaidCacheTable(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE mermaid_cache_mu (
      user_id      INTEGER NOT NULL DEFAULT 0,
      mermaid_hash TEXT NOT NULL,
      qiniu_key    TEXT NOT NULL,
      url          TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (user_id, mermaid_hash)
    );
  `);
  if (tableHasColumn('mermaid_cache', 'user_id')) {
    d.exec(`
      INSERT OR IGNORE INTO mermaid_cache_mu (user_id, mermaid_hash, qiniu_key, url, created_at)
      SELECT user_id, mermaid_hash, qiniu_key, url, created_at FROM mermaid_cache;
    `);
  } else {
    d.exec(`
      INSERT OR IGNORE INTO mermaid_cache_mu (user_id, mermaid_hash, qiniu_key, url, created_at)
      SELECT 0, mermaid_hash, qiniu_key, url, created_at FROM mermaid_cache;
    `);
  }
  d.exec('DROP TABLE mermaid_cache');
  d.exec('ALTER TABLE mermaid_cache_mu RENAME TO mermaid_cache');
}

function migrateToMultiUser(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('admin','member')),
      status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)');
  d.exec(`
    CREATE TABLE IF NOT EXISTS storage_profiles (
      user_id         INTEGER PRIMARY KEY REFERENCES users(id),
      access_key      TEXT NOT NULL,
      secret_key_enc  TEXT NOT NULL,
      bucket          TEXT NOT NULL,
      domain          TEXT NOT NULL,
      zone            TEXT NOT NULL DEFAULT 'Zone_z0',
      private_bucket  INTEGER NOT NULL DEFAULT 0,
      url_ttl         INTEGER NOT NULL DEFAULT 3600,
      verified_at     INTEGER,
      updated_at      INTEGER NOT NULL
    );
  `);

  const flag = d.prepare('SELECT value FROM schema_meta WHERE key=?').get('multi_user') as
    | { value: string }
    | undefined;
  if (flag?.value === '1') return;

  d.exec('BEGIN');
  try {
    recreateDocsTable();
    recreateSharesTable();
    recreateMediaTable();
    recreateMermaidCacheTable();
    d.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('multi_user', '1');
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function migrateArchiveSchema(): void {
  const d = getDb();
  try {
    d.exec('ALTER TABLE docs ADD COLUMN archive_path TEXT');
  } catch {
    /* 列已存在则忽略 */
  }
  try {
    d.exec('ALTER TABLE shares ADD COLUMN source_content_sha256 TEXT');
  } catch {
    /* 列已存在则忽略 */
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS archive_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, path)
    );
  `);
  d.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_archive_path ON docs(user_id, archive_path) WHERE archive_path IS NOT NULL',
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_archive_folders_user ON archive_folders(user_id)');
}

/** 初始化 SQLite。dbFile 缺省为项目根 data/ptdoc.db。重复调用安全。 */
export function initDB(dbFile?: string): void {
  if (db) return;
  const file = dbFile ?? join(process.cwd(), 'data', 'ptdoc.db');
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
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
  try {
    db.exec('ALTER TABLE docs ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* 列已存在则忽略 */
  }
  try {
    db.exec('ALTER TABLE shares ADD COLUMN html_url TEXT');
  } catch {
    /* 列已存在则忽略 */
  }
  try {
    db.exec('ALTER TABLE shares ADD COLUMN md_url TEXT');
  } catch {
    /* 列已存在则忽略 */
  }
  migrateToMultiUser();
  migrateArchiveSchema();
}

export function closeDB(): void {
  if (!db) return;
  db.close();
  db = null;
}

export function isMultiUserMigrated(): boolean {
  const row = getDb().prepare('SELECT value FROM schema_meta WHERE key=?').get('multi_user') as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function docsHasUserId(): boolean {
  return tableHasColumn('docs', 'user_id');
}

// ─── 用户 ──────────────────────────────────────────────
export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: number;
  updated_at: number;
}

export interface UserPublic {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  created_at: number;
}

export function countUsers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return Number(row.n);
}

export function createUser(username: string, passwordHash: string, role: UserRole): UserRow {
  const now = Date.now();
  const info = getDb()
    .prepare(
      'INSERT INTO users (username, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(username, passwordHash, role, 'active', now, now);
  const id = Number(info.lastInsertRowid);
  return getUserById(id)!;
}

export function getUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as UserRow | undefined;
}

export function getUserByUsername(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username) as
    | unknown as UserRow
    | undefined;
}

export function listUsers(): UserPublic[] {
  return getDb()
    .prepare(
      'SELECT id, username, role, status, created_at FROM users ORDER BY id ASC',
    )
    .all() as unknown as UserPublic[];
}

export function updateUserRole(id: number, role: UserRole): void {
  const r = getDb().prepare('UPDATE users SET role=?, updated_at=? WHERE id=?').run(role, Date.now(), id);
  if (Number(r.changes) === 0) throw new Error('用户不存在');
}

export function updateUserStatus(id: number, status: UserStatus): void {
  const r = getDb().prepare('UPDATE users SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), id);
  if (Number(r.changes) === 0) throw new Error('用户不存在');
}

export function updateUserPassword(id: number, passwordHash: string): void {
  const r = getDb()
    .prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?')
    .run(passwordHash, Date.now(), id);
  if (Number(r.changes) === 0) throw new Error('用户不存在');
}

export function claimOrphanRecords(userId: number): void {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare('UPDATE docs SET user_id=? WHERE user_id=0').run(userId);
    d.prepare('UPDATE shares SET user_id=? WHERE user_id=0').run(userId);
    d.prepare('UPDATE media SET user_id=? WHERE user_id=0').run(userId);
    d.prepare('UPDATE mermaid_cache SET user_id=? WHERE user_id=0').run(userId);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ─── Session ───────────────────────────────────────────
export interface SessionRow {
  token_hash: string;
  user_id: number;
  expires_at: number;
  created_at: number;
}

export function insertSession(tokenHash: string, userId: number, expiresAt: number): void {
  getDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(tokenHash, userId, expiresAt, Date.now());
}

export function getSessionUser(tokenHash: string): UserRow | undefined {
  const now = Date.now();
  return getDb()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=? AND s.expires_at>?`,
    )
    .get(tokenHash, now) as unknown as UserRow | undefined;
}

export function touchSession(tokenHash: string, expiresAt: number): void {
  getDb().prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(expiresAt, tokenHash);
}

export function deleteSession(tokenHash: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
}

export function deleteSessionsForUser(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

// ─── Storage Profile ───────────────────────────────────
export interface StorageProfileRow {
  user_id: number;
  access_key: string;
  secret_key_enc: string;
  bucket: string;
  domain: string;
  zone: string;
  private_bucket: number;
  url_ttl: number;
  verified_at: number | null;
  updated_at: number;
}

export function getStorageProfile(userId: number): StorageProfileRow | undefined {
  return getDb().prepare('SELECT * FROM storage_profiles WHERE user_id=?').get(userId) as
    | unknown as StorageProfileRow
    | undefined;
}

export function upsertStorageProfile(
  userId: number,
  fields: {
    access_key: string;
    secret_key_enc: string;
    bucket: string;
    domain: string;
    zone: string;
    private_bucket: boolean;
    url_ttl: number;
    verified_at: number | null;
  },
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO storage_profiles
        (user_id, access_key, secret_key_enc, bucket, domain, zone, private_bucket, url_ttl, verified_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
        access_key=excluded.access_key,
        secret_key_enc=excluded.secret_key_enc,
        bucket=excluded.bucket,
        domain=excluded.domain,
        zone=excluded.zone,
        private_bucket=excluded.private_bucket,
        url_ttl=excluded.url_ttl,
        verified_at=excluded.verified_at,
        updated_at=excluded.updated_at`,
    )
    .run(
      userId,
      fields.access_key,
      fields.secret_key_enc,
      fields.bucket,
      fields.domain,
      fields.zone,
      fields.private_bucket ? 1 : 0,
      fields.url_ttl,
      fields.verified_at,
      now,
    );
}

interface DocRow {
  id: number;
  user_id: number;
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
  userId: number,
  docKey: string,
  title: string,
  filename: string,
  content: string,
): { id: number; doc_key: string } {
  const now = Date.now();
  const existing = getDb()
    .prepare('SELECT id, created_at FROM docs WHERE user_id=? AND doc_key=?')
    .get(userId, docKey) as unknown as { id: number; created_at: number } | undefined;
  if (existing) {
    getDb()
      .prepare(
        'UPDATE docs SET title=?, filename=?, content=?, updated_at=?, last_opened_at=? WHERE user_id=? AND doc_key=?',
      )
      .run(title, filename, content, now, now, userId, docKey);
    return { id: existing.id, doc_key: docKey };
  }
  const info = getDb()
    .prepare(
      'INSERT INTO docs (user_id, doc_key, title, filename, content, created_at, updated_at, last_opened_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(userId, docKey, title, filename, content, now, now, now);
  return { id: Number(info.lastInsertRowid), doc_key: docKey };
}

export function getDoc(userId: number, id: number): DocRow | undefined {
  return getDb().prepare('SELECT * FROM docs WHERE id=? AND user_id=?').get(id, userId) as
    | unknown as DocRow
    | undefined;
}

export function searchDocs(userId: number, q: string, limit = 50): DocSummary[] {
  const like = `%${q}%`;
  return getDb()
    .prepare(
      `SELECT id, doc_key, title, filename, updated_at, last_opened_at FROM docs
       WHERE user_id=? AND (title LIKE ? OR filename LIKE ? OR content LIKE ?)
       ORDER BY last_opened_at DESC, updated_at DESC LIMIT ?`,
    )
    .all(userId, like, like, like, limit) as unknown as DocSummary[];
}

export function listRecent(userId: number, limit = 50): DocSummary[] {
  return getDb()
    .prepare(
      'SELECT id, doc_key, title, filename, updated_at, last_opened_at FROM docs WHERE user_id=? ORDER BY last_opened_at DESC, updated_at DESC LIMIT ?',
    )
    .all(userId, limit) as unknown as DocSummary[];
}

/** 全部文档（按 doc_key 排序），供侧边栏文档树构建。 */
export function listAllDocs(userId: number): DocSummary[] {
  return getDb()
    .prepare(
      'SELECT id, doc_key, title, filename, updated_at, last_opened_at FROM docs WHERE user_id=? ORDER BY doc_key ASC',
    )
    .all(userId) as unknown as DocSummary[];
}

/** 全部文档全文（含 content），供前端全文搜索索引构建。 */
export function listAllDocsFull(userId: number): Array<DocRow & DocSummary> {
  return getDb()
    .prepare('SELECT * FROM docs WHERE user_id=? ORDER BY doc_key ASC')
    .all(userId) as unknown as Array<DocRow & DocSummary>;
}

/** 重命名文档：更新 doc_key 并级联更新该文档的 shares 引用（同一事务）。 */
export function renameDoc(userId: number, id: number, newKey: string): { ok: boolean } {
  const row = getDb().prepare('SELECT doc_key FROM docs WHERE id=? AND user_id=?').get(id, userId) as
    | { doc_key: string }
    | undefined;
  if (!row) throw new Error('文档不存在');
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare('UPDATE docs SET doc_key=?, updated_at=? WHERE id=? AND user_id=?').run(
      newKey,
      Date.now(),
      id,
      userId,
    );
    if (row.doc_key !== newKey) {
      d.prepare('UPDATE shares SET doc_key=? WHERE user_id=? AND doc_key=?').run(newKey, userId, row.doc_key);
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

/** 删除文档记录：级联删除其分享记录、分享图片映射与版本快照（同一事务）。 */
export function deleteDoc(userId: number, id: number): { ok: boolean } {
  const row = getDb().prepare('SELECT doc_key FROM docs WHERE id=? AND user_id=?').get(id, userId) as
    | { doc_key: string }
    | undefined;
  if (!row) throw new Error('文档不存在');
  const d = getDb();
  d.exec('BEGIN');
  try {
    const shareIds = (
      d.prepare('SELECT id FROM shares WHERE user_id=? AND doc_key=?').all(userId, row.doc_key) as Array<{
        id: number;
      }>
    ).map((r) => r.id);
    for (const sid of shareIds) d.prepare('DELETE FROM images WHERE share_id=?').run(sid);
    d.prepare('DELETE FROM shares WHERE user_id=? AND doc_key=?').run(userId, row.doc_key);
    d.prepare('DELETE FROM doc_versions WHERE doc_id=?').run(id);
    d.prepare('DELETE FROM docs WHERE id=? AND user_id=?').run(id, userId);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
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

function assertOwnedDoc(userId: number, docId: number): DocRow {
  const doc = getDoc(userId, docId);
  if (!doc) throw new Error('文档不存在');
  return doc;
}

/** 基于文档当前内容生成一条不可变快照（可带标签）。 */
export function createSnapshot(userId: number, docId: number, label?: string): { id: number } {
  const doc = assertOwnedDoc(userId, docId);
  const info = getDb()
    .prepare('INSERT INTO doc_versions (doc_id, content, label, created_at) VALUES (?,?,?,?)')
    .run(docId, doc.content, label?.trim() || null, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

export function listSnapshots(userId: number, docId: number): SnapshotRow[] {
  assertOwnedDoc(userId, docId);
  return getDb()
    .prepare('SELECT * FROM doc_versions WHERE doc_id=? ORDER BY created_at DESC, id DESC')
    .all(docId) as unknown as SnapshotRow[];
}

/** 把快照内容写回文档当前工作副本（docs.content），不生成新快照。 */
export function restoreSnapshot(userId: number, docId: number, snapshotId: number): { ok: boolean } {
  assertOwnedDoc(userId, docId);
  const snap = getDb()
    .prepare('SELECT content FROM doc_versions WHERE id=? AND doc_id=?')
    .get(snapshotId, docId) as { content: string } | undefined;
  if (!snap) throw new Error('快照不存在');
  getDb()
    .prepare('UPDATE docs SET content=?, updated_at=? WHERE id=? AND user_id=?')
    .run(snap.content, Date.now(), docId, userId);
  return { ok: true };
}

export function deleteSnapshot(userId: number, snapshotId: number): { ok: boolean } {
  const row = getDb()
    .prepare(
      `SELECT v.id FROM doc_versions v JOIN docs d ON d.id=v.doc_id
       WHERE v.id=? AND d.user_id=?`,
    )
    .get(snapshotId, userId) as { id: number } | undefined;
  if (!row) throw new Error('快照不存在');
  getDb().prepare('DELETE FROM doc_versions WHERE id=?').run(snapshotId);
  return { ok: true };
}

// ─── 媒体库（media）─────────────────────────────────────
export interface MediaRow {
  id: number;
  user_id: number;
  qiniu_key: string;
  url: string;
  filename: string;
  source: 'direct' | 'mermaid';
  size: number;
  created_at: number;
}

/** 记录一次图床上传（直接上传 source='direct'，分享版 mermaid 图 source='mermaid'）。 */
export function insertMedia(
  userId: number,
  qiniuKey: string,
  url: string,
  filename: string,
  source: string,
  size: number,
): { id: number } {
  const info = getDb()
    .prepare(
      'INSERT INTO media (user_id, qiniu_key, url, filename, source, size, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(userId, qiniuKey, url, filename, source === 'mermaid' ? 'mermaid' : 'direct', size, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

export function listMedia(userId: number, q?: string, source?: string): MediaRow[] {
  const conds: string[] = ['user_id=?'];
  const args: Array<string | number> = [userId];
  if (source === 'direct' || source === 'mermaid') {
    conds.push('source=?');
    args.push(source);
  }
  if (q) {
    conds.push('(filename LIKE ? OR url LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like);
  }
  const where = 'WHERE ' + conds.join(' AND ');
  return getDb()
    .prepare(`SELECT * FROM media ${where} ORDER BY created_at DESC LIMIT 500`)
    .all(...args) as unknown as MediaRow[];
}

/** 取单条媒体记录（删除前校验存在性）。 */
export function getMedia(userId: number, id: number): MediaRow | undefined {
  return getDb().prepare('SELECT * FROM media WHERE id=? AND user_id=?').get(id, userId) as
    | unknown as MediaRow
    | undefined;
}

export function deleteMediaRecord(userId: number, id: number): void {
  getDb().prepare('DELETE FROM media WHERE id=? AND user_id=?').run(id, userId);
}

export interface ShareImage {
  qiniu_key: string;
  url: string;
  mermaid_hash?: string;
}

/** 记录一次分享版生成：保存分享 md 文本 + 其包含的每张图片映射 + 已上传的 .md/.html 永久链接。 */
export function insertShare(
  userId: number,
  docKey: string | null,
  shareMd: string,
  images: ShareImage[],
  mdUrl?: string,
  htmlUrl?: string,
): { id: number } {
  const now = Date.now();
  const info = getDb()
    .prepare(
      'INSERT INTO shares (user_id, doc_key, share_md, md_url, html_url, source_content_sha256, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      userId,
      docKey,
      shareMd,
      mdUrl ?? null,
      htmlUrl ?? null,
      htmlUrl ? contentSha256(userId, docKey) : null,
      now,
    );
  const shareId = Number(info.lastInsertRowid);
  const stmt = getDb().prepare(
    'INSERT INTO images (share_id, qiniu_key, url, mermaid_hash, created_at) VALUES (?,?,?,?,?)',
  );
  for (const im of images) {
    stmt.run(shareId, im.qiniu_key, im.url, im.mermaid_hash ?? null, now);
  }
  if (htmlUrl && docKey) ensureArchivePath(userId, docKey);
  return { id: shareId };
}

export interface ShareRow {
  id: number;
  user_id: number;
  doc_key: string | null;
  md_url: string | null;
  html_url: string | null;
  created_at: number;
}

export interface ShareDetail {
  id: number;
  user_id: number;
  doc_key: string | null;
  share_md: string;
  md_url: string | null;
  html_url: string | null;
}

/** 取单条分享记录（含 share_md，用于托管页 /s/:id 渲染与「查看 MD」）。 */
export function getShare(userId: number, id: number): ShareDetail | undefined {
  return getDb()
    .prepare('SELECT id, user_id, doc_key, share_md, md_url, html_url FROM shares WHERE id=? AND user_id=?')
    .get(id, userId) as unknown as ShareDetail | undefined;
}

/** 删除分享记录及其图片映射（不影响七牛上已上传的 HTML/图片）。 */
export function deleteShare(userId: number, id: number): { ok: boolean } {
  const row = getShare(userId, id);
  if (!row) throw new Error('分享记录不存在');
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM images WHERE share_id=?').run(id);
    d.prepare('DELETE FROM shares WHERE id=? AND user_id=?').run(id, userId);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

export function listShares(userId: number, docKey?: string): ShareRow[] {
  if (docKey) {
    return getDb()
      .prepare(
        'SELECT id, user_id, doc_key, md_url, html_url, created_at FROM shares WHERE user_id=? AND doc_key=? ORDER BY created_at DESC',
      )
      .all(userId, docKey) as unknown as ShareRow[];
  }
  return getDb()
    .prepare(
      'SELECT id, user_id, doc_key, md_url, html_url, created_at FROM shares WHERE user_id=? ORDER BY created_at DESC',
    )
    .all(userId) as unknown as ShareRow[];
}

/** 上传分享版 HTML 成功后，把永久公开链接回写对应分享记录。 */
export function updateShareHtmlUrl(userId: number, shareId: number, htmlUrl: string): void {
  const share = getShare(userId, shareId);
  if (!share) throw new Error('分享记录不存在');
  const hash = htmlUrl ? contentSha256(userId, share.doc_key) : null;
  getDb()
    .prepare('UPDATE shares SET html_url=?, source_content_sha256=? WHERE id=? AND user_id=?')
    .run(htmlUrl || null, hash, shareId, userId);
  if (htmlUrl && share.doc_key) ensureArchivePath(userId, share.doc_key);
}

/** 取分享记录的图片映射（按发布顺序），供前端做"当前文档 vs 上次发布"一致性检查。 */
export function listShareImages(shareId: number): ShareImage[] {
  return getDb()
    .prepare('SELECT qiniu_key, url, mermaid_hash FROM images WHERE share_id=? ORDER BY id ASC')
    .all(shareId) as unknown as ShareImage[];
}

// ─── mermaid -> 已上传图片 的按用户缓存（按内容哈希去重）──
export function getMermaidCache(userId: number): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT mermaid_hash, url FROM mermaid_cache WHERE user_id=?')
    .all(userId) as unknown as Array<{ mermaid_hash: string; url: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.mermaid_hash] = r.url;
  return map;
}

export function putMermaidCache(userId: number, hash: string, key: string, url: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO mermaid_cache (user_id, mermaid_hash, qiniu_key, url, created_at) VALUES (?,?,?,?,?)',
    )
    .run(userId, hash, key, url, now);
}

// ─── 归档目录树 ─────────────────────────────────────────

export interface ArchiveEntry {
  id: number;
  doc_key: string;
  title: string;
  archive_path: string;
  share_id: number;
  html_url: string;
  md_url: string | null;
  created_at: number;
  stale: boolean;
}

export interface ArchiveFolder {
  id: number;
  path: string;
  created_at: number;
}

function sha256Text(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function contentSha256(userId: number, docKey: string | null): string | null {
  if (!docKey) return null;
  const row = getDb()
    .prepare('SELECT content FROM docs WHERE user_id=? AND doc_key=?')
    .get(userId, docKey) as { content: string } | undefined;
  if (!row) return null;
  return sha256Text(row.content);
}

type PathKind = 'doc' | 'folder';

function pairConflict(
  a: { path: string; kind: PathKind },
  b: { path: string; kind: PathKind },
): 'dup' | 'prefix' | null {
  if (a.path === b.path) return 'dup';
  if (a.kind === 'doc' && b.path.startsWith(a.path + '/')) return 'prefix';
  if (b.kind === 'doc' && a.path.startsWith(b.path + '/')) return 'prefix';
  return null;
}

export function normalizeArchivePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError(400, '路径非法：须为字符串');
  const path = raw.trim().replace(/^\/+|\/+$/g, '');
  assertValidArchivePath(path);
  return path;
}

function assertValidArchivePath(path: string): void {
  if (path.length < 1 || path.length > 256) {
    throw new HttpError(400, '路径非法：去掉首尾 / 与空白后长度须为 1～256');
  }
  if (/[\x00-\x1f]/.test(path)) {
    throw new HttpError(400, '路径非法：禁止控制字符');
  }
  for (const seg of path.split('/')) {
    if (!seg) throw new HttpError(400, '路径非法：禁止空分段');
    if (seg === '.' || seg === '..') throw new HttpError(400, '路径非法：禁止 . 与 ..');
  }
}

function listOccupiedPaths(
  userId: number,
  exclude?: { docId?: number; folderPath?: string },
): { docs: Array<{ id: number; path: string }>; folders: string[] } {
  const docRows = getDb()
    .prepare(
      'SELECT id, archive_path FROM docs WHERE user_id=? AND archive_path IS NOT NULL AND archive_path != \'\'',
    )
    .all(userId) as Array<{ id: number; archive_path: string }>;
  const docs = docRows
    .filter((r) => r.id !== exclude?.docId)
    .map((r) => ({ id: r.id, path: r.archive_path }));
  const folders = (
    getDb().prepare('SELECT path FROM archive_folders WHERE user_id=?').all(userId) as Array<{ path: string }>
  )
    .map((r) => r.path)
    .filter((p) => p !== exclude?.folderPath);
  return { docs, folders };
}

function assertNoPathConflict(
  userId: number,
  path: string,
  kind: PathKind,
  exclude?: { docId?: number; folderPath?: string },
): void {
  const occupied = listOccupiedPaths(userId, exclude);
  const items: Array<{ path: string; kind: PathKind }> = [
    ...occupied.docs.map((d) => ({ path: d.path, kind: 'doc' as const })),
    ...occupied.folders.map((f) => ({ path: f, kind: 'folder' as const })),
    { path, kind },
  ];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const c = pairConflict(items[i], items[j]);
      if (c === 'dup') throw new HttpError(409, '归档路径已被占用');
      if (c === 'prefix') throw new HttpError(409, '同一路径不能既是文档又是文件夹');
    }
  }
}

function tryAssignArchivePath(userId: number, docId: number, path: string): boolean {
  try {
    assertValidArchivePath(path);
    assertNoPathConflict(userId, path, 'doc', { docId });
    getDb().prepare('UPDATE docs SET archive_path=? WHERE id=? AND user_id=?').run(path, docId, userId);
    return true;
  } catch {
    return false;
  }
}

/** 若文档尚无 archive_path，写入 doc_key；冲突则改用 doc_key~id。 */
export function ensureArchivePath(userId: number, docKey: string): void {
  const doc = getDb()
    .prepare('SELECT id, archive_path FROM docs WHERE user_id=? AND doc_key=?')
    .get(userId, docKey) as { id: number; archive_path: string | null } | undefined;
  if (!doc || doc.archive_path) return;
  if (tryAssignArchivePath(userId, doc.id, docKey)) return;
  if (tryAssignArchivePath(userId, doc.id, `${docKey}~${doc.id}`)) return;
  for (let n = 2; n < 50; n++) {
    if (tryAssignArchivePath(userId, doc.id, `${docKey}~${doc.id}~${n}`)) return;
  }
}

function hasPublishedShare(userId: number, docKey: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM shares
       WHERE user_id=? AND doc_key=? AND html_url IS NOT NULL AND html_url != ''
       LIMIT 1`,
    )
    .get(userId, docKey) as { id: number } | undefined;
  return Boolean(row);
}

export function listArchiveFolders(userId: number): ArchiveFolder[] {
  return getDb()
    .prepare('SELECT id, path, created_at FROM archive_folders WHERE user_id=? ORDER BY path ASC')
    .all(userId) as unknown as ArchiveFolder[];
}

export function listArchive(userId: number, q?: string): { entries: ArchiveEntry[]; folders: ArchiveFolder[] } {
  const shareRows = getDb()
    .prepare(
      `SELECT id, doc_key, html_url, md_url, created_at, source_content_sha256
       FROM shares
       WHERE user_id=? AND html_url IS NOT NULL AND html_url != ''
         AND doc_key IS NOT NULL AND doc_key != ''
       ORDER BY created_at DESC, id DESC`,
    )
    .all(userId) as Array<{
    id: number;
    doc_key: string;
    html_url: string;
    md_url: string | null;
    created_at: number;
    source_content_sha256: string | null;
  }>;
  const latest = new Map<string, (typeof shareRows)[number]>();
  for (const s of shareRows) {
    if (!latest.has(s.doc_key)) latest.set(s.doc_key, s);
  }

  const docs = getDb()
    .prepare('SELECT id, doc_key, title, content, archive_path FROM docs WHERE user_id=?')
    .all(userId) as Array<{
    id: number;
    doc_key: string;
    title: string;
    content: string;
    archive_path: string | null;
  }>;
  const docByKey = new Map(docs.map((d) => [d.doc_key, d]));

  const entries: ArchiveEntry[] = [];
  for (const [docKey, share] of latest) {
    const doc = docByKey.get(docKey);
    if (!doc) continue;
    if (!doc.archive_path) {
      ensureArchivePath(userId, docKey);
      const again = getDb()
        .prepare('SELECT archive_path FROM docs WHERE id=?')
        .get(doc.id) as { archive_path: string | null };
      doc.archive_path = again.archive_path;
    }
    if (!doc.archive_path) continue;
    const stale = Boolean(
      share.source_content_sha256 && sha256Text(doc.content) !== share.source_content_sha256,
    );
    entries.push({
      id: doc.id,
      doc_key: doc.doc_key,
      title: doc.title,
      archive_path: doc.archive_path,
      share_id: share.id,
      html_url: share.html_url,
      md_url: share.md_url,
      created_at: share.created_at,
      stale,
    });
  }

  let folders = listArchiveFolders(userId);
  const needle = q?.trim().toLowerCase();
  let filtered = entries;
  if (needle) {
    filtered = entries.filter(
      (e) => e.title.toLowerCase().includes(needle) || e.archive_path.toLowerCase().includes(needle),
    );
    folders = folders.filter(
      (f) =>
        f.path.toLowerCase().includes(needle) ||
        filtered.some((e) => e.archive_path === f.path || e.archive_path.startsWith(f.path + '/')),
    );
  }
  return { entries: filtered, folders };
}

export function updateArchivePath(userId: number, docId: number, archivePath: string): { ok: boolean } {
  const path = normalizeArchivePath(archivePath);
  const doc = getDoc(userId, docId);
  if (!doc) throw new HttpError(404, '不存在');
  if (!hasPublishedShare(userId, doc.doc_key)) throw new HttpError(400, '文档尚未归档');
  assertNoPathConflict(userId, path, 'doc', { docId });
  getDb().prepare('UPDATE docs SET archive_path=? WHERE id=? AND user_id=?').run(path, docId, userId);
  return { ok: true };
}

export function createArchiveFolder(userId: number, rawPath: unknown): ArchiveFolder {
  const path = normalizeArchivePath(rawPath);
  assertNoPathConflict(userId, path, 'folder');
  const now = Date.now();
  const info = getDb()
    .prepare('INSERT INTO archive_folders (user_id, path, created_at) VALUES (?,?,?)')
    .run(userId, path, now);
  return { id: Number(info.lastInsertRowid), path, created_at: now };
}

function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(from + '/')) return to + path.slice(from.length);
  return path;
}

export function renameArchiveFolder(userId: number, rawFrom: unknown, rawTo: unknown): { ok: boolean } {
  const from = normalizeArchivePath(rawFrom);
  const to = normalizeArchivePath(rawTo);
  if (from === to) return { ok: true };

  const folders = listArchiveFolders(userId);
  const docRows = getDb()
    .prepare(
      'SELECT id, archive_path FROM docs WHERE user_id=? AND archive_path IS NOT NULL AND archive_path != \'\'',
    )
    .all(userId) as Array<{ id: number; archive_path: string }>;

  const inSubtree = (p: string) => p === from || p.startsWith(from + '/');
  const movingFolders = folders.filter((f) => inSubtree(f.path));
  const movingDocs = docRows.filter((d) => inSubtree(d.archive_path));
  if (movingFolders.length === 0 && movingDocs.length === 0) {
    throw new HttpError(404, '文件夹不存在');
  }

  const newFolderPaths = movingFolders.map((f) => replacePathPrefix(f.path, from, to));
  const newDocPaths = movingDocs.map((d) => replacePathPrefix(d.archive_path, from, to));
  for (const p of [...newFolderPaths, ...newDocPaths]) assertValidArchivePath(p);

  const outsideFolders = folders.filter((f) => !inSubtree(f.path)).map((f) => f.path);
  const outsideDocs = docRows.filter((d) => !inSubtree(d.archive_path)).map((d) => d.archive_path);
  const nextAll: Array<{ path: string; kind: PathKind }> = [
    ...outsideFolders.map((p) => ({ path: p, kind: 'folder' as const })),
    ...outsideDocs.map((p) => ({ path: p, kind: 'doc' as const })),
    ...newFolderPaths.map((p) => ({ path: p, kind: 'folder' as const })),
    ...newDocPaths.map((p) => ({ path: p, kind: 'doc' as const })),
  ];
  for (let i = 0; i < nextAll.length; i++) {
    for (let j = i + 1; j < nextAll.length; j++) {
      const c = pairConflict(nextAll[i], nextAll[j]);
      if (c === 'dup') throw new HttpError(409, '归档路径已被占用');
      if (c === 'prefix') throw new HttpError(409, '同一路径不能既是文档又是文件夹');
    }
  }

  const d = getDb();
  d.exec('BEGIN');
  try {
    for (const f of movingFolders) {
      d.prepare('UPDATE archive_folders SET path=? WHERE id=? AND user_id=?').run(
        replacePathPrefix(f.path, from, to),
        f.id,
        userId,
      );
    }
    for (const doc of movingDocs) {
      d.prepare('UPDATE docs SET archive_path=? WHERE id=? AND user_id=?').run(
        replacePathPrefix(doc.archive_path, from, to),
        doc.id,
        userId,
      );
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    if (String(e).includes('UNIQUE')) throw new HttpError(409, '归档路径已被占用');
    throw e;
  }
  return { ok: true };
}

export function deleteArchiveFolder(userId: number, rawPath: unknown): { ok: boolean } {
  const path = normalizeArchivePath(rawPath);
  const row = getDb()
    .prepare('SELECT id FROM archive_folders WHERE user_id=? AND path=?')
    .get(userId, path) as { id: number } | undefined;
  const child = getDb()
    .prepare(
      `SELECT d.id FROM docs d
       WHERE d.user_id=? AND d.archive_path IS NOT NULL
         AND (d.archive_path=? OR d.archive_path LIKE ?)
         AND EXISTS (
           SELECT 1 FROM shares s
           WHERE s.user_id=d.user_id AND s.doc_key=d.doc_key
             AND s.html_url IS NOT NULL AND s.html_url != ''
         )
       LIMIT 1`,
    )
    .get(userId, path, path + '/%') as { id: number } | undefined;
  if (child) throw new HttpError(400, '文件夹内还有归档文档');
  if (!row) throw new HttpError(404, '文件夹不存在');
  getDb().prepare('DELETE FROM archive_folders WHERE id=? AND user_id=?').run(row.id, userId);
  return { ok: true };
}
