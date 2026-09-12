import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

function migrateAgentTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS llm_profiles (
      user_id        INTEGER PRIMARY KEY,
      base_url       TEXT NOT NULL,
      api_key_enc    TEXT NOT NULL,
      model          TEXT NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qdrant_profiles (
      user_id       INTEGER PRIMARY KEY,
      url           TEXT NOT NULL,
      api_key_enc   TEXT,
      collection    TEXT NOT NULL,
      vector_name   TEXT,
      top_k         INTEGER NOT NULL DEFAULT 5,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_extensions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,
      name          TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      config_json   TEXT NOT NULL,
      secrets_enc   TEXT,
      file_dir      TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE(kind, name)
    );
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      scene         TEXT NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_turns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      draft_md        TEXT,
      trace_id        TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_traces (
      trace_id        TEXT PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      turn_id         INTEGER NOT NULL,
      model           TEXT,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      latency_ms      INTEGER,
      hits_json       TEXT,
      spans_json      TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_conv_user ON agent_conversations(user_id, scene, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_turns_conv ON agent_turns(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_agent_traces_user ON agent_traces(user_id, conversation_id);
  `);
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
  migrateAgentTables();
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

export function getDocByKey(userId: number, docKey: string): DocRow | undefined {
  return getDb().prepare('SELECT * FROM docs WHERE user_id=? AND doc_key=?').get(userId, docKey) as
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
      'INSERT INTO shares (user_id, doc_key, share_md, md_url, html_url, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(userId, docKey, shareMd, mdUrl ?? null, htmlUrl ?? null, now);
  const shareId = Number(info.lastInsertRowid);
  const stmt = getDb().prepare(
    'INSERT INTO images (share_id, qiniu_key, url, mermaid_hash, created_at) VALUES (?,?,?,?,?)',
  );
  for (const im of images) {
    stmt.run(shareId, im.qiniu_key, im.url, im.mermaid_hash ?? null, now);
  }
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
  const r = getDb()
    .prepare('UPDATE shares SET html_url=? WHERE id=? AND user_id=?')
    .run(htmlUrl, shareId, userId);
  if (Number(r.changes) === 0) throw new Error('分享记录不存在');
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

// ─── Agent profiles / conversations / extensions ────────

export interface LlmProfileRow {
  user_id: number;
  base_url: string;
  api_key_enc: string;
  model: string;
  updated_at: number;
}

export interface QdrantProfileRow {
  user_id: number;
  url: string;
  api_key_enc: string | null;
  collection: string;
  vector_name: string | null;
  top_k: number;
  updated_at: number;
}

export interface AgentExtensionRow {
  id: number;
  kind: string;
  name: string;
  enabled: number;
  config_json: string;
  secrets_enc: string | null;
  file_dir: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentConversationRow {
  id: number;
  user_id: number;
  scene: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface AgentTurnRow {
  id: number;
  conversation_id: number;
  user_id: number;
  role: string;
  content: string;
  draft_md: string | null;
  trace_id: string | null;
  created_at: number;
}

export interface AgentTraceRow {
  trace_id: string;
  user_id: number;
  conversation_id: number;
  turn_id: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  hits_json: string | null;
  spans_json: string | null;
  created_at: number;
}

export function getLlmProfile(userId: number): LlmProfileRow | undefined {
  return getDb().prepare('SELECT * FROM llm_profiles WHERE user_id=?').get(userId) as unknown as
    | LlmProfileRow
    | undefined;
}

export function upsertLlmProfile(userId: number, baseUrl: string, apiKeyEnc: string, model: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO llm_profiles (user_id, base_url, api_key_enc, model, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET base_url=excluded.base_url, api_key_enc=excluded.api_key_enc,
         model=excluded.model, updated_at=excluded.updated_at`,
    )
    .run(userId, baseUrl, apiKeyEnc, model, now);
}

export function getQdrantProfile(userId: number): QdrantProfileRow | undefined {
  return getDb().prepare('SELECT * FROM qdrant_profiles WHERE user_id=?').get(userId) as unknown as
    | QdrantProfileRow
    | undefined;
}

export function upsertQdrantProfile(
  userId: number,
  url: string,
  apiKeyEnc: string | null,
  collection: string,
  vectorName: string | null,
  topK: number,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO qdrant_profiles (user_id, url, api_key_enc, collection, vector_name, top_k, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET url=excluded.url, api_key_enc=excluded.api_key_enc,
         collection=excluded.collection, vector_name=excluded.vector_name, top_k=excluded.top_k,
         updated_at=excluded.updated_at`,
    )
    .run(userId, url, apiKeyEnc, collection, vectorName, topK, now);
}

export function insertAgentExtension(row: {
  kind: string;
  name: string;
  enabled?: number;
  config_json: string;
  secrets_enc?: string | null;
  file_dir?: string | null;
}): AgentExtensionRow {
  const now = Date.now();
  try {
    const info = getDb()
      .prepare(
        `INSERT INTO agent_extensions (kind, name, enabled, config_json, secrets_enc, file_dir, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(row.kind, row.name, row.enabled ?? 1, row.config_json, row.secrets_enc ?? null, row.file_dir ?? null, now, now);
    return getAgentExtension(Number(info.lastInsertRowid))!;
  } catch (e) {
    const msg = (e as Error).message || '';
    if (msg.includes('UNIQUE')) throw Object.assign(new Error('扩展名称已存在'), { code: 'EXT_DUP' });
    throw e;
  }
}

export function getAgentExtension(id: number): AgentExtensionRow | undefined {
  return getDb().prepare('SELECT * FROM agent_extensions WHERE id=?').get(id) as unknown as
    | AgentExtensionRow
    | undefined;
}

export function getAgentExtensionByName(kind: string, name: string): AgentExtensionRow | undefined {
  return getDb().prepare('SELECT * FROM agent_extensions WHERE kind=? AND name=?').get(kind, name) as unknown as
    | AgentExtensionRow
    | undefined;
}

export function listAgentExtensions(kind?: string, q?: string): AgentExtensionRow[] {
  if (kind && q) {
    return getDb()
      .prepare('SELECT * FROM agent_extensions WHERE kind=? AND name LIKE ? ORDER BY updated_at DESC')
      .all(kind, `%${q}%`) as unknown as AgentExtensionRow[];
  }
  if (kind) {
    return getDb()
      .prepare('SELECT * FROM agent_extensions WHERE kind=? ORDER BY updated_at DESC')
      .all(kind) as unknown as AgentExtensionRow[];
  }
  if (q) {
    return getDb()
      .prepare('SELECT * FROM agent_extensions WHERE name LIKE ? ORDER BY updated_at DESC')
      .all(`%${q}%`) as unknown as AgentExtensionRow[];
  }
  return getDb().prepare('SELECT * FROM agent_extensions ORDER BY updated_at DESC').all() as unknown as AgentExtensionRow[];
}

export function listEnabledAgentExtensions(): AgentExtensionRow[] {
  return getDb()
    .prepare('SELECT * FROM agent_extensions WHERE enabled=1 ORDER BY id ASC')
    .all() as unknown as AgentExtensionRow[];
}

export function updateAgentExtension(
  id: number,
  patch: {
    name?: string;
    enabled?: number;
    config_json?: string;
    secrets_enc?: string | null;
    file_dir?: string | null;
  },
): AgentExtensionRow {
  const cur = getAgentExtension(id);
  if (!cur) throw Object.assign(new Error('扩展不存在'), { code: 'EXT_MISS' });
  try {
    getDb()
      .prepare(
        `UPDATE agent_extensions SET name=?, enabled=?, config_json=?, secrets_enc=?, file_dir=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.name ?? cur.name,
        patch.enabled ?? cur.enabled,
        patch.config_json ?? cur.config_json,
        patch.secrets_enc === undefined ? cur.secrets_enc : patch.secrets_enc,
        patch.file_dir === undefined ? cur.file_dir : patch.file_dir,
        Date.now(),
        id,
      );
  } catch (e) {
    const msg = (e as Error).message || '';
    if (msg.includes('UNIQUE')) throw Object.assign(new Error('扩展名称已存在'), { code: 'EXT_DUP' });
    throw e;
  }
  return getAgentExtension(id)!;
}

export function deleteAgentExtension(id: number): boolean {
  const r = getDb().prepare('DELETE FROM agent_extensions WHERE id=?').run(id);
  return Number(r.changes) > 0;
}

export function createAgentConversation(userId: number, scene: string, title = ''): AgentConversationRow {
  const now = Date.now();
  const info = getDb()
    .prepare(
      'INSERT INTO agent_conversations (user_id, scene, title, created_at, updated_at) VALUES (?,?,?,?,?)',
    )
    .run(userId, scene, title, now, now);
  return getAgentConversation(userId, Number(info.lastInsertRowid))!;
}

export function getAgentConversation(userId: number, id: number): AgentConversationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_conversations WHERE id=? AND user_id=?')
    .get(id, userId) as unknown as AgentConversationRow | undefined;
}

export function listAgentConversations(userId: number, scene?: string): AgentConversationRow[] {
  if (scene) {
    return getDb()
      .prepare(
        'SELECT * FROM agent_conversations WHERE user_id=? AND scene=? ORDER BY updated_at DESC',
      )
      .all(userId, scene) as unknown as AgentConversationRow[];
  }
  return getDb()
    .prepare('SELECT * FROM agent_conversations WHERE user_id=? ORDER BY updated_at DESC')
    .all(userId) as unknown as AgentConversationRow[];
}

export function touchAgentConversation(userId: number, id: number, title?: string): void {
  if (title !== undefined) {
    getDb()
      .prepare('UPDATE agent_conversations SET title=?, updated_at=? WHERE id=? AND user_id=?')
      .run(title, Date.now(), id, userId);
    return;
  }
  getDb()
    .prepare('UPDATE agent_conversations SET updated_at=? WHERE id=? AND user_id=?')
    .run(Date.now(), id, userId);
}

export function deleteAgentConversation(userId: number, id: number): boolean {
  const d = getDb();
  const row = getAgentConversation(userId, id);
  if (!row) return false;
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM agent_traces WHERE conversation_id=? AND user_id=?').run(id, userId);
    d.prepare('DELETE FROM agent_turns WHERE conversation_id=? AND user_id=?').run(id, userId);
    d.prepare('DELETE FROM agent_conversations WHERE id=? AND user_id=?').run(id, userId);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return true;
}

export function insertAgentTurn(row: {
  conversation_id: number;
  user_id: number;
  role: string;
  content: string;
  draft_md?: string | null;
  trace_id?: string | null;
}): AgentTurnRow {
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO agent_turns (conversation_id, user_id, role, content, draft_md, trace_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(row.conversation_id, row.user_id, row.role, row.content, row.draft_md ?? null, row.trace_id ?? null, now);
  return getDb().prepare('SELECT * FROM agent_turns WHERE id=?').get(Number(info.lastInsertRowid)) as unknown as AgentTurnRow;
}

export function listAgentTurns(userId: number, conversationId: number): AgentTurnRow[] {
  return getDb()
    .prepare('SELECT * FROM agent_turns WHERE conversation_id=? AND user_id=? ORDER BY id ASC')
    .all(conversationId, userId) as unknown as AgentTurnRow[];
}

export function getAgentTurn(userId: number, conversationId: number, turnId: number): AgentTurnRow | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_turns WHERE id=? AND conversation_id=? AND user_id=?')
    .get(turnId, conversationId, userId) as unknown as AgentTurnRow | undefined;
}

export function insertAgentTrace(row: AgentTraceRow): void {
  getDb()
    .prepare(
      `INSERT INTO agent_traces (trace_id, user_id, conversation_id, turn_id, model, input_tokens, output_tokens, latency_ms, hits_json, spans_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.trace_id,
      row.user_id,
      row.conversation_id,
      row.turn_id,
      row.model,
      row.input_tokens,
      row.output_tokens,
      row.latency_ms,
      row.hits_json,
      row.spans_json,
      row.created_at,
    );
}

export function getAgentTrace(userId: number, traceId: string): AgentTraceRow | undefined {
  return getDb().prepare('SELECT * FROM agent_traces WHERE trace_id=? AND user_id=?').get(traceId, userId) as unknown as
    | AgentTraceRow
    | undefined;
}

export function getAgentTraceByTurn(userId: number, conversationId: number, turnId: number): AgentTraceRow | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_traces WHERE user_id=? AND conversation_id=? AND turn_id=?')
    .get(userId, conversationId, turnId) as unknown as AgentTraceRow | undefined;
}
