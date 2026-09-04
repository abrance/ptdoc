import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  closeDB,
  initDB,
  isMultiUserMigrated,
  docsHasUserId,
  countUsers,
  createUser,
  claimOrphanRecords,
  upsertDoc,
  listAllDocs,
  getDoc,
  getMermaidCache,
  putMermaidCache,
  insertShare,
  getShare,
} from './db.ts';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db');
}

test('旧库迁移后含 user_id 且 users 仍为空', () => {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_key TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_key TEXT,
      share_md TEXT NOT NULL,
      md_url TEXT,
      html_url TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qiniu_key TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'direct',
      size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE mermaid_cache (
      mermaid_hash TEXT PRIMARY KEY,
      qiniu_key TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  raw.prepare(
    'INSERT INTO docs (doc_key, title, filename, content, created_at, updated_at, last_opened_at) VALUES (?,?,?,?,?,?,?)',
  ).run('notes/a.md', 'A', 'a.md', '# A', 1, 1, 1);
  raw.close();

  initDB(file);
  assert.equal(isMultiUserMigrated(), true);
  assert.equal(docsHasUserId(), true);
  assert.equal(countUsers(), 0);
  const docs = listAllDocs(0);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].doc_key, 'notes/a.md');
  closeDB();
});

test('同名 doc_key 分用户隔离；跨用户读取不存在', () => {
  initDB(tmpDb());
  const a = createUser('alice', 'hash', 'member');
  const b = createUser('bob', 'hash', 'member');
  upsertDoc(a.id, 'notes/a.md', 'A1', 'a.md', '# from a');
  upsertDoc(b.id, 'notes/a.md', 'B1', 'a.md', '# from b');
  assert.equal(listAllDocs(a.id).length, 1);
  assert.equal(listAllDocs(b.id).length, 1);
  const da = listAllDocs(a.id)[0];
  assert.equal(getDoc(b.id, da.id), undefined);
  assert.equal(getDoc(a.id, da.id)?.content, '# from a');
  closeDB();
});

test('mermaid_cache 按用户隔离', () => {
  initDB(tmpDb());
  const a = createUser('alice', 'hash', 'member');
  const b = createUser('bob', 'hash', 'member');
  putMermaidCache(a.id, 'abc', 'k', 'https://a.example/x.png');
  assert.equal(getMermaidCache(a.id).abc, 'https://a.example/x.png');
  assert.equal(getMermaidCache(b.id).abc, undefined);
  closeDB();
});

test('Setup 认领无主记录后仅该用户可见', () => {
  initDB(tmpDb());
  upsertDoc(0, 'old.md', 'Old', 'old.md', '# old');
  const admin = createUser('admin', 'hash', 'admin');
  claimOrphanRecords(admin.id);
  assert.equal(listAllDocs(admin.id).length, 1);
  assert.equal(listAllDocs(0).length, 0);
  closeDB();
});

test('分享记录跨用户 404', () => {
  initDB(tmpDb());
  const a = createUser('alice', 'hash', 'member');
  const b = createUser('bob', 'hash', 'member');
  const s = insertShare(a.id, 'a.md', '# share', []);
  assert.ok(getShare(a.id, s.id));
  assert.equal(getShare(b.id, s.id), undefined);
  closeDB();
});
