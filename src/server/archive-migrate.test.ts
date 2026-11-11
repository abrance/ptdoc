import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDB, initDB } from './db.ts';

/** 造一个「多用户已迁移、归档产物列还没加」的旧库，模拟线上升级前的状态。 */
function makeLegacyDb(file: string): void {
  const d = new DatabaseSync(file);
  d.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('multi_user','1');
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0,
      doc_key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL DEFAULT 0, archive_path TEXT,
      qdrant_sync_share_id INTEGER, qdrant_synced_at INTEGER,
      UNIQUE(user_id, doc_key)
    );
    CREATE TABLE shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0,
      doc_key TEXT, share_md TEXT NOT NULL, md_url TEXT, html_url TEXT,
      created_at INTEGER NOT NULL, source_content_sha256 TEXT
    );
    CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, share_id INTEGER NOT NULL, qiniu_key TEXT NOT NULL, url TEXT NOT NULL, mermaid_hash TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE doc_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, content TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE media (id INTEGER PRIMARY KEY AUTOINCREMENT, qiniu_key TEXT NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'direct', size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE mermaid_cache (mermaid_hash TEXT PRIMARY KEY, qiniu_key TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE archive_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, path));
  `);
  const now = Date.now();
  d.prepare('INSERT INTO users (username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(
    'u',
    'x',
    'admin',
    'active',
    now,
    now,
  );
  // 5 篇文档；A~D 有分享，E 没有
  const docs = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const [i, key] of docs.entries()) {
    d.prepare(
      'INSERT INTO docs (user_id,doc_key,title,filename,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(1, key, '文档 ' + key, key + '.md', 'content of ' + key, now + i, now + i);
  }
  // 12 条 shares：a=4, b=3, c=2, d=2, e=0；同一文档同一 created_at 也要能稳定编号
  const plan: Array<[string, number]> = [
    ['a', 4],
    ['b', 3],
    ['c', 2],
    ['d', 2],
    ['e', 1],
  ];
  let n = 0;
  for (const [key, count] of plan) {
    for (let i = 0; i < count; i++) {
      n++;
      d.prepare(
        'INSERT INTO shares (user_id,doc_key,share_md,md_url,html_url,created_at,source_content_sha256) VALUES (?,?,?,?,?,?,?)',
      ).run(1, key, `md-${key}-${i}`, `https://cdn/${key}/${i}.md`, `https://cdn/${key}/${i}.html`, now + n, null);
    }
  }
  d.close();
}

test('FR-19 存量迁移：5 文档 12 shares → 每文档 1 条 active、版本连续、token 回填', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-arch-mig-'));
  const file = join(dir, 't.db');
  makeLegacyDb(file);

  initDB(file);
  const d = new DatabaseSync(file);
  const rows = d
    .prepare('SELECT doc_key, version, status, superseded_at, created_at FROM shares ORDER BY doc_key, version')
    .all() as Array<{ doc_key: string; version: number; status: string; superseded_at: number | null; created_at: number }>;
  assert.equal(rows.length, 12, '不删任何行');

  const byDoc = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byDoc.get(r.doc_key) ?? [];
    list.push(r);
    byDoc.set(r.doc_key, list);
  }
  for (const [docKey, list] of byDoc) {
    const versions = list.map((r) => r.version);
    assert.deepEqual(versions, Array.from({ length: list.length }, (_, i) => i + 1), `${docKey} 版本应为 1..n`);
    const active = list.filter((r) => r.status === 'active');
    assert.equal(active.length, 1, `${docKey} 应恰有 1 条 active`);
    assert.equal(active[0].version, list.length, `${docKey} active 应为最新版`);
    const superseded = list.filter((r) => r.status === 'superseded');
    assert.equal(superseded.length, list.length - 1);
    for (const s of superseded) assert.equal(s.superseded_at, s.created_at);
  }

  const tokens = d.prepare('SELECT doc_key, archive_token FROM docs ORDER BY doc_key').all() as Array<{
    doc_key: string;
    archive_token: string | null;
  }>;
  for (const t of tokens) {
    if (t.doc_key === 'f') {
      assert.equal(t.archive_token, null, '无分享的文档不回填 token（D10）');
    } else {
      assert.ok(t.archive_token && t.archive_token.length >= 43, `${t.doc_key} 应回填 43 字符 token`);
      assert.match(t.archive_token!, /^[A-Za-z0-9_-]+$/);
    }
  }
  // token 互不相同
  const set = new Set(tokens.map((t) => t.archive_token).filter(Boolean));
  assert.equal(set.size, 5);

  const idx = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('ux_shares_active','ux_docs_archive_token')").all() as Array<{ name: string }>;
  assert.equal(idx.length, 2, '唯一索引应已创建');
  const ver = d.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(ver.user_version, 7);

  // 重复启动不重复迁移：版本号不被重新编号，也不再产生备份
  const before = d.prepare('SELECT id, version, status FROM shares ORDER BY id').all();
  d.close();
  closeDB();
  initDB(file);
  const d2 = new DatabaseSync(file);
  const after = d2.prepare('SELECT id, version, status FROM shares ORDER BY id').all();
  assert.deepEqual(after, before, '重复启动不应改动已有数据');
  const baks = readdirSync(dir).filter((f) => f.includes('.bak-'));
  assert.equal(baks.length, 1, '只应备份一次');
  d2.close();
  closeDB();
});

test('FR-19 唯一索引生效：同文档第二条 active 插入报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-arch-uq-'));
  const file = join(dir, 't.db');
  makeLegacyDb(file);
  initDB(file);
  const d = new DatabaseSync(file);
  assert.throws(() => {
    d.prepare("INSERT INTO shares (user_id,doc_key,share_md,created_at,version,status) VALUES (1,'a','x',1,9,'active')").run();
  }, /UNIQUE|constraint/i);
  d.close();
  closeDB();
});
