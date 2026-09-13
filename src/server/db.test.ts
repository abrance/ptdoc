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
  listArchive,
  updateArchivePath,
  createArchiveFolder,
  renameArchiveFolder,
  deleteArchiveFolder,
  updateShareHtmlUrl,
  renameDoc,
  deleteShare,
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

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { status?: number }).status;
  }
}

test('写入 html_url 后进入归档，默认路径等于 doc_key；notes.md 与 notes/a.md 可并存', () => {
  initDB(tmpDb());
  const u = createUser('alice', 'hash', 'member');
  upsertDoc(u.id, 'notes.md', 'N', 'notes.md', '# n');
  upsertDoc(u.id, 'notes/a.md', 'A', 'a.md', '# a');
  insertShare(u.id, 'notes.md', '# n', [], undefined, 'https://qiniu.example/n.html');
  insertShare(u.id, 'notes/a.md', '# a', [], undefined, 'https://qiniu.example/a.html');
  const { entries } = listArchive(u.id);
  assert.equal(entries.length, 2);
  const byKey = Object.fromEntries(entries.map((e) => [e.doc_key, e]));
  assert.equal(byKey['notes.md'].archive_path, 'notes.md');
  assert.equal(byKey['notes/a.md'].archive_path, 'notes/a.md');
  closeDB();
});

test('同一 doc_key 两次分享，列表只有一条且 share_id 为较新记录', () => {
  initDB(tmpDb());
  const u = createUser('alice', 'hash', 'member');
  upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a');
  const s1 = insertShare(u.id, 'a.md', '# a1', [], undefined, 'https://qiniu.example/1.html');
  const s2 = insertShare(u.id, 'a.md', '# a2', [], undefined, 'https://qiniu.example/2.html');
  const { entries } = listArchive(u.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].share_id, s2.id);
  assert.notEqual(entries[0].share_id, s1.id);
  closeDB();
});

test('改 archive_path 不改 doc_key；冲突第二次写入失败', () => {
  initDB(tmpDb());
  const u = createUser('alice', 'hash', 'member');
  const d1 = upsertDoc(u.id, 'notes.md', 'N', 'notes.md', '# n');
  const d2 = upsertDoc(u.id, 'other.md', 'O', 'other.md', '# o');
  insertShare(u.id, 'notes.md', '# n', [], undefined, 'https://qiniu.example/n.html');
  insertShare(u.id, 'other.md', '# o', [], undefined, 'https://qiniu.example/o.html');
  updateArchivePath(u.id, d1.id, 'proj/n.md');
  assert.equal(getDoc(u.id, d1.id)?.doc_key, 'notes.md');
  assert.equal(listArchive(u.id).entries.find((e) => e.id === d1.id)?.archive_path, 'proj/n.md');
  assert.equal(statusOf(() => updateArchivePath(u.id, d2.id, 'proj/n.md')), 409);
  closeDB();
});

test('无 html_url 的 Share 不出现在 listArchive', () => {
  initDB(tmpDb());
  const u = createUser('alice', 'hash', 'member');
  upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a');
  insertShare(u.id, 'a.md', '# a', []);
  assert.equal(listArchive(u.id).entries.length, 0);
  closeDB();
});

test('用户 B 看不到用户 A 的归档条目', () => {
  initDB(tmpDb());
  const a = createUser('alice', 'hash', 'member');
  const b = createUser('bob', 'hash', 'member');
  upsertDoc(a.id, 'a.md', 'A', 'a.md', '# a');
  insertShare(a.id, 'a.md', '# a', [], undefined, 'https://qiniu.example/a.html');
  assert.equal(listArchive(a.id).entries.length, 1);
  assert.equal(listArchive(b.id).entries.length, 0);
  closeDB();
});

test('新建空文件夹后 listArchive.folders 含该路径', () => {
  initDB(tmpDb());
  const u = createUser('alice', 'hash', 'member');
  createArchiveFolder(u.id, 'inbox');
  const { entries, folders } = listArchive(u.id);
  assert.equal(entries.length, 0);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].path, 'inbox');
  closeDB();
});

test('重命名文件夹 a → b 后 a/x 变为 b/x，doc_key 不变', () => {
  initDB(tmpDb());
  const u = createUser('alice', 'hash', 'member');
  const d = upsertDoc(u.id, 'notes.md', 'N', 'notes.md', '# n');
  insertShare(u.id, 'notes.md', '# n', [], undefined, 'https://qiniu.example/n.html');
  updateArchivePath(u.id, d.id, 'a/x.md');
  renameArchiveFolder(u.id, 'a', 'b');
  const e = listArchive(u.id).entries[0];
  assert.equal(e.archive_path, 'b/x.md');
  assert.equal(getDoc(u.id, d.id)?.doc_key, 'notes.md');
  closeDB();
});

test('删除非空文件夹失败；删光分享后文档从 entries 消失', () => {
  initDB(tmpDb());
  const u = createUser('alice', 'hash', 'member');
  const d = upsertDoc(u.id, 'notes.md', 'N', 'notes.md', '# n');
  const share = insertShare(u.id, 'notes.md', '# n', [], undefined, 'https://qiniu.example/n.html');
  updateArchivePath(u.id, d.id, 'a/x.md');
  createArchiveFolder(u.id, 'a');
  assert.equal(statusOf(() => deleteArchiveFolder(u.id, 'a')), 400);
  deleteShare(u.id, share.id);
  assert.equal(listArchive(u.id).entries.length, 0);
  deleteArchiveFolder(u.id, 'a');
  assert.equal(listArchive(u.id).folders.length, 0);
  closeDB();
});

test('改 content 后 stale 为 true；只改 updated_at 或 doc_key 时为 false；无 hash 的旧分享不为 stale', () => {
  const file = tmpDb();
  initDB(file);
  const u = createUser('alice', 'hash', 'member');
  const d = upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a');
  insertShare(u.id, 'a.md', '# a', [], undefined, 'https://qiniu.example/a.html');
  assert.equal(listArchive(u.id).entries[0].stale, false);
  upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a');
  assert.equal(listArchive(u.id).entries[0].stale, false);
  renameDoc(u.id, d.id, 'b.md');
  assert.equal(listArchive(u.id).entries[0].stale, false);
  upsertDoc(u.id, 'b.md', 'A', 'b.md', '# changed');
  assert.equal(listArchive(u.id).entries[0].stale, true);
  closeDB();

  initDB(tmpDb());
  const u2 = createUser('bob', 'hash', 'member');
  upsertDoc(u2.id, 'old.md', 'O', 'old.md', '# old');
  const s = insertShare(u2.id, 'old.md', '# old', []);
  updateShareHtmlUrl(u2.id, s.id, 'https://qiniu.example/old.html');
  assert.equal(listArchive(u2.id).entries[0].stale, false);
  closeDB();

  const file2 = tmpDb();
  initDB(file2);
  const u3 = createUser('cara', 'hash', 'member');
  upsertDoc(u3.id, 'c.md', 'C', 'c.md', '# c');
  insertShare(u3.id, 'c.md', '# c', []);
  closeDB();
  const raw = new DatabaseSync(file2);
  raw.prepare("UPDATE shares SET html_url=?, source_content_sha256=NULL WHERE doc_key='c.md'").run(
    'https://qiniu.example/c.html',
  );
  raw.close();
  initDB(file2);
  assert.equal(listArchive(u3.id).entries[0].stale, false);
  closeDB();
});
