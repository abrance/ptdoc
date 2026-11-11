import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeDB,
  createSnapshot,
  createUser,
  deleteSnapshot,
  getRetention,
  getVersion,
  initDB,
  listVersions,
  restoreSnapshot,
  setRetention,
  upsertDoc,
} from './db.ts';

/** 造一个 user_version=7（归档产物已迁移、快照还没升级）的存量库。 */
function makeV7Db(file: string): void {
  const d = new DatabaseSync(file);
  d.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0,
      doc_key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL DEFAULT 0, archive_path TEXT,
      qdrant_sync_share_id INTEGER, qdrant_synced_at INTEGER, archive_token TEXT,
      UNIQUE(user_id, doc_key)
    );
    CREATE TABLE shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0,
      doc_key TEXT, share_md TEXT NOT NULL, md_url TEXT, html_url TEXT, created_at INTEGER NOT NULL,
      source_content_sha256 TEXT, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
      note TEXT, md_size INTEGER, html_size INTEGER, source_kind TEXT NOT NULL DEFAULT 'share',
      superseded_at INTEGER, deleted_at INTEGER, md_key TEXT, html_key TEXT
    );
    CREATE TABLE doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, content TEXT NOT NULL,
      label TEXT, created_at INTEGER NOT NULL
    );
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
  for (const [i, key] of ['a', 'b'].entries()) {
    d.prepare(
      'INSERT INTO docs (user_id,doc_key,title,filename,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(1, key, '文档 ' + key, key + '.md', '存量正文 ' + key, now + i, now + i);
  }
  // 存量快照：旧表没有 kind/sha/size
  for (const [i, content] of ['旧版本一', '旧版本二', ''].entries()) {
    d.prepare('INSERT INTO doc_versions (doc_id,content,label,created_at) VALUES (?,?,?,?)').run(
      1,
      content,
      i === 0 ? '手写备注' : null,
      now + i,
    );
  }
  d.exec('PRAGMA user_version = 7');
  d.close();
}

function freshUser(): number {
  return createUser('m2', 'x', 'admin').id;
}

test('M2-0 迁移(8)：存量快照回填 kind/sha/size，建 user_settings，重复启动不重复迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-mig-'));
  const file = join(dir, 't.db');
  makeV7Db(file);

  initDB(file);
  const d = new DatabaseSync(file);
  assert.equal((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);
  const cols = (d.prepare('PRAGMA table_info(doc_versions)').all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ['kind', 'content_sha256', 'size']) assert.ok(cols.includes(c), `doc_versions 应新增 ${c}`);
  assert.ok(
    (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'").all() as unknown[]).length,
    'user_settings 应存在',
  );
  const rows = d
    .prepare('SELECT id, content, label, kind, content_sha256, size FROM doc_versions ORDER BY id')
    .all() as Array<{ id: number; content: string; label: string | null; kind: string; content_sha256: string; size: number }>;
  assert.equal(rows.length, 3, '不删任何存量快照');
  assert.equal(rows[0].label, '手写备注', 'label 保持');
  for (const r of rows) {
    assert.equal(r.kind, 'manual', '存量快照一律视为 manual');
    assert.match(r.content_sha256, /^[0-9a-f]{64}$/, '回填 sha256');
    assert.equal(r.size, Buffer.byteLength(r.content, 'utf8'), '回填字节数');
  }
  d.close();

  // 重复启动：不重新迁移、不再产生备份、数据不变
  closeDB();
  initDB(file);
  const d2 = new DatabaseSync(file);
  assert.equal((d2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);
  assert.equal(
    (d2.prepare('SELECT COUNT(*) AS n FROM doc_versions').get() as { n: number }).n,
    3,
    '重复启动不改动快照',
  );
  d2.close();
  closeDB();
  assert.equal(
    readdirSync(dir).filter((f) => f.includes('.bak-')).length,
    1,
    '只应备份一次（快照迁移只跑一次；归档迁移在 user_version=7 时已跳过）',
  );
});

test('M2-0 down 可回滚：v8 → v7 恢复 5 列并删 user_settings，再启动能重新迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-down-'));
  const file = join(dir, 't.db');
  makeV7Db(file);
  initDB(file);
  const uid = freshUser();
  upsertDoc(uid, 'doc-down', 't', 't.md', '回滚演练正文');
  closeDB();

  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/snapshot-migrate-down.ts', file],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const d = new DatabaseSync(file);
  assert.equal((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
  const cols = (d.prepare('PRAGMA table_info(doc_versions)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols.sort(), ['content', 'created_at', 'doc_id', 'id', 'label']);
  assert.equal(
    (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'").all() as unknown[]).length,
    0,
    'user_settings 应被删除',
  );
  assert.equal(
    (d.prepare('SELECT COUNT(*) AS n FROM doc_versions').get() as { n: number }).n,
    4,
    '回滚不删快照（3 条存量 + 1 条自动）',
  );
  d.close();

  // 回滚后服务仍能启动：重新迁移回 8
  initDB(file);
  const d2 = new DatabaseSync(file);
  assert.equal((d2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);
  assert.equal(
    (d2.prepare('SELECT COUNT(*) AS n FROM doc_versions').get() as { n: number }).n,
    4,
    '重新迁移后快照数不变',
  );
  d2.close();
  closeDB();
});

test('M2-1 自动快照：内容哈希去重（连续保存合并），换内容才新增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-auto-'));
  initDB(join(dir, 't.db'));
  const uid = freshUser();

  upsertDoc(uid, 'auto', 't', 't.md', 'v1');
  for (let i = 0; i < 5; i++) upsertDoc(uid, 'auto', 't', 't.md', 'v1');
  const doc = upsertDoc(uid, 'auto', 't', 't.md', 'v1');
  let items = listVersions(uid, doc.id).items;
  assert.equal(items.length, 1, '同一内容连续保存 7 次只留 1 条 auto');
  assert.equal(items[0].kind, 'auto');

  upsertDoc(uid, 'auto', 't', 't.md', 'v2');
  items = listVersions(uid, doc.id).items;
  assert.equal(items.length, 2, '换内容新增 1 条');
  assert.equal(items[0].sha256_short.length, 7);

  upsertDoc(uid, 'auto', 't', 't.md', 'v1');
  items = listVersions(uid, doc.id).items;
  assert.equal(items.length, 2, '改回历史内容不新增（全文已在列表里）');
  assert.equal(items[0].kind, 'auto');
  closeDB();
});

test('M2-2 回滚前自动保存：恢复内容且新增一条 manual「回滚前自动保存」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-restore-'));
  initDB(join(dir, 't.db'));
  const uid = freshUser();
  const { id } = upsertDoc(uid, 'r', 't', 't.md', '第一版');
  const v1 = listVersions(uid, id).items[0].id;
  upsertDoc(uid, 'r', 't', 't.md', '第二版：当前内容');

  const out = restoreSnapshot(uid, id, v1);
  assert.equal(out.ok, true);
  const doc = upsertDoc(uid, 'r', 't', 't.md', '第二版：当前内容'); // 只为拿 doc，不改变行为
  assert.ok(doc.id);

  const pre = getVersion(uid, id, out.pre_restore_version_id);
  assert.ok(pre, '回滚前那条快照应存在');
  assert.equal(pre!.kind, 'manual');
  assert.equal(pre!.label, '回滚前自动保存');
  assert.equal(pre!.content, '第二版：当前内容', '备份的是回滚前的当前内容');

  const versions = listVersions(uid, id).items;
  assert.ok(versions.some((v) => v.id === v1), '被恢复的旧版本仍在列表里');
  const texts = versions.map((v) => getVersion(uid, id, v.id)!.content);
  assert.ok(texts.includes('第一版'), '原内容可恢复');
  closeDB();
});

test('M2-3 版本接口：列表不含 content、kind 过滤、游标翻页', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-list-'));
  initDB(join(dir, 't.db'));
  const uid = freshUser();
  const { id } = upsertDoc(uid, 'l', 't', 't.md', 'a');
  upsertDoc(uid, 'l', 't', 't.md', 'b');
  createSnapshot(uid, id, '手动一');
  upsertDoc(uid, 'l', 't', 't.md', 'c');

  const all = listVersions(uid, id, { limit: 50 });
  assert.equal(all.items.length, 4, '3 auto + 1 manual');
  assert.equal(all.next_cursor, null);
  assert.ok(!('content' in all.items[0]), '列表项不带正文');

  const autos = listVersions(uid, id, { kind: 'auto' });
  assert.equal(autos.items.length, 3);
  assert.ok(autos.items.every((v) => v.kind === 'auto'));

  const page1 = listVersions(uid, id, { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(typeof page1.next_cursor, 'number');
  const page2 = listVersions(uid, id, { limit: 2, cursor: page1.next_cursor! });
  assert.equal(page2.items.length, 2);
  const ids = new Set([...page1.items, ...page2.items].map((v) => v.id));
  assert.equal(ids.size, 4, '翻页不重复不丢');
  closeDB();
});

test('M2-5 留存策略(条数)：超过 keep_count 只裁 auto，manual 永不裁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-keep-'));
  const file = join(dir, 't.db');
  initDB(file);
  const uid = freshUser();
  const { id } = upsertDoc(uid, 'k', 't', 't.md', 'base');
  createSnapshot(uid, id, '手动底稿');
  for (let i = 0; i < 15; i++) upsertDoc(uid, 'k', 't', 't.md', '内容-' + i);

  const before = getRetention(uid);
  assert.deepEqual(
    {
      c: before.snapshot_keep_count,
      d: before.snapshot_keep_days,
      m: before.snapshot_keep_min,
    },
    { c: 10, d: 7, m: 1 },
    '默认 10 / 7 / 1',
  );
  assert.equal(before.total, 17, '1 manual + 16 auto');
  // count=10 时：位置 11 及之后的 auto 被裁，manual 不参与
  assert.equal(before.prune_estimate, 6, '预估清理 6 条 auto');

  const after = setRetention(uid, { snapshot_keep_count: 10 });
  assert.equal(after.pruned, 6);
  assert.equal(after.total, 11, '剩 1 manual + 10 auto');
  const kinds = listVersions(uid, id, { limit: 200 }).items.map((v) => v.kind);
  assert.equal(kinds.filter((k) => k === 'manual').length, 1, 'manual 仍在');
  closeDB();
  assert.ok(file);
});

test('M2-5 留存策略(天数)：超过 keep_days 的 auto 被裁，min 兜底', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-days-'));
  const file = join(dir, 't.db');
  initDB(file);
  const uid = freshUser();
  const { id } = upsertDoc(uid, 'd', 't', 't.md', 'now-0');
  upsertDoc(uid, 'd', 't', 't.md', 'now-1');
  upsertDoc(uid, 'd', 't', 't.md', 'now-2');
  for (let i = 0; i < 4; i++) upsertDoc(uid, 'd', 't', 't.md', 'old-' + i);

  // 把后 4 条（最老）调到 10 天前
  const items = listVersions(uid, id, { limit: 200 }).items;
  assert.equal(items.length, 7);
  const oldIds = items.slice(3).map((v) => v.id);
  closeDB();
  const d = new DatabaseSync(file);
  const tenDaysAgo = Date.now() - 10 * 86_400_000;
  for (const vid of oldIds) d.prepare('UPDATE doc_versions SET created_at=? WHERE id=?').run(tenDaysAgo, vid);
  d.close();
  initDB(file);

  const view = getRetention(uid);
  assert.equal(view.prune_estimate, 4, '4 条超 7 天');
  const out = setRetention(uid, { snapshot_keep_days: 7, snapshot_keep_count: 200 });
  assert.equal(out.pruned, 4);
  assert.equal(out.total, 3, '只留最近 3 条');
  closeDB();
});

test('M2-5 留存策略(min)：每个文档至少保留 keep_min 条，且 auto 不能手动删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-snap-min-'));
  initDB(join(dir, 't.db'));
  const uid = freshUser();
  const { id } = upsertDoc(uid, 'm', 't', 't.md', 'm0');
  upsertDoc(uid, 'm', 't', 't.md', 'm1');
  upsertDoc(uid, 'm', 't', 't.md', 'm2');

  const out = setRetention(uid, { snapshot_keep_count: 2, snapshot_keep_min: 2 });
  assert.equal(out.total, 2, 'min=2 兜住 2 条');
  assert.equal(out.pruned, 1);

  // 范围校验：min 不能大于 count（会被夹到 count），count 上限 200 / 下限 1
  const clamped = setRetention(uid, { snapshot_keep_count: 1, snapshot_keep_min: 5, snapshot_keep_days: 999 });
  assert.deepEqual(
    { c: clamped.snapshot_keep_count, d: clamped.snapshot_keep_days, m: clamped.snapshot_keep_min },
    { c: 1, d: 365, m: 1 },
    '三个字段按范围夹取，min ≤ count',
  );

  const autoId = listVersions(uid, id, { limit: 5 }).items.find((v) => v.kind === 'auto')!.id;
  assert.throws(
    () => deleteSnapshot(uid, autoId),
    (e: Error & { status?: number }) => e.status === 400 && /自动快照只能被留存策略淘汰/.test(e.message),
    'auto 删除应返回 400',
  );
  closeDB();
});
