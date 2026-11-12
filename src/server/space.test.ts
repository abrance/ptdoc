import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  closeDB,
  initDB,
  createUser,
  insertSession,
  upsertDoc,
  getDoc,
  listAllDocs,
  listSpaces,
  createSpace,
  renameSpace,
  deleteSpace,
  reorderSpaces,
  listSpaceTree,
  createSpaceFolder,
  renameSpaceFolder,
  deleteSpaceFolder,
  moveSpaceFolder,
  moveDoc,
  reorderDoc,
  ensureDefaultSpace,
  claimOrphanRecords,
} from './db.ts';
import { HttpError, hasBareDocKeySlash } from './http.ts';
import { hashToken } from './auth.ts';
import { apiMiddleware } from './api.ts';
import { loadServerEnv } from './env.ts';

afterEach(() => closeDB());

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'ptdoc-space-')), 't.db');
}

/** 建一个「空间改造前」的库：docs 无 space_id / folder_id / sort_order。 */
function legacyDb(file: string, docs: Array<{ key: string; updated: number; opened: number }>): void {
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
  const ins = raw.prepare(
    'INSERT INTO docs (doc_key, title, filename, content, created_at, updated_at, last_opened_at) VALUES (?,?,?,?,?,?,?)',
  );
  for (const d of docs) ins.run(d.key, d.key, d.key, '# x', 1, d.updated, d.opened);
  raw.close();
}

function isHttp(status: number) {
  return (e: unknown) => e instanceof HttpError && e.status === status;
}

const is409 = isHttp(409);
const is400 = isHttp(400);
const is404 = isHttp(404);

test('迁移：存量文档全部进该用户 default space，顺序按最近打开/更新，跑两遍一致', () => {
  const file = tmpDb();
  // 旧库 → 首启迁移 → 把孤儿文档认领给 admin，再跑一次迁移
  legacyDb(file, [
    { key: 'old.md', updated: 20, opened: 30 },
    { key: 'older.md', updated: 10, opened: 10 },
    { key: 'newest.md', updated: 40, opened: 90 },
  ]);
  initDB(file);
  const admin = createUser('admin', 'x', 'admin');
  const docs0 = listAllDocs(0);
  assert.equal(docs0.length, 3);
  // 无用户时先落 user 0 的 default 空间，保证 space_id 非空
  assert.ok(docs0.every((d) => d.space_id !== null));

  // 把 user 0 的空间和文档一起认领；旧库迁移顺序在 claim 之前，这里手工重现
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE spaces SET user_id=? WHERE user_id=0").run(admin.id);
  raw.prepare('UPDATE docs SET user_id=? WHERE user_id=0').run(admin.id);
  raw.close();

  const before = listSpaceTree(admin.id, ensureDefaultSpace(admin.id).id);
  assert.equal(before.folders.length, 0);
  assert.deepEqual(
    before.docs.map((d) => d.doc_key),
    ['newest.md', 'old.md', 'older.md'],
    '按 last_opened_at DESC, updated_at DESC, id DESC 回填 sort_order',
  );
  assert.deepEqual(
    before.docs.map((d) => d.sort_order),
    [0, 1, 2],
  );
  assert.ok(before.docs.every((d) => d.folder_id === null));

  // 第二遍迁移：结果不变（幂等）
  closeDB();
  initDB(file);
  const after = listSpaceTree(admin.id, ensureDefaultSpace(admin.id).id);
  assert.deepEqual(
    after.docs.map((d) => [d.id, d.doc_key, d.sort_order]),
    before.docs.map((d) => [d.id, d.doc_key, d.sort_order]),
  );
  assert.equal(listSpaces(admin.id).length, 1);
  assert.equal(listSpaces(admin.id)[0].is_default, 1);
  closeDB();
});

test('旧单用户库：首个用户注册后，user 0 的 default 空间与文档一并归属到他', () => {
  const file = tmpDb();
  legacyDb(file, [
    { key: 'a.md', updated: 5, opened: 5 },
    { key: 'b.md', updated: 6, opened: 6 },
  ]);
  initDB(file);
  // 迁移先给 user 0 建了 default 空间并回填
  const raw = new DatabaseSync(file);
  const orphan = raw.prepare('SELECT COUNT(*) AS n FROM spaces WHERE user_id=0').get() as { n: number };
  assert.equal(orphan.n, 1);
  raw.close();
  const admin = createUser('first', 'x', 'admin');
  claimOrphanRecords(admin.id);
  const spaces = listSpaces(admin.id);
  assert.equal(spaces.length, 1, 'user 0 的空间并入默认空间，不残留第二个');
  assert.equal(spaces[0].is_default, 1);
  const tree = listSpaceTree(admin.id, spaces[0].id);
  assert.deepEqual(
    tree.docs.map((d) => d.doc_key),
    ['b.md', 'a.md'],
  );
  const check = new DatabaseSync(file);
  const left = check.prepare('SELECT COUNT(*) AS n FROM spaces WHERE user_id=0').get() as { n: number };
  assert.equal(left.n, 0, '不留 user_id=0 的空间');
  const nulls = check.prepare('SELECT COUNT(*) AS n FROM docs WHERE space_id IS NULL').get() as { n: number };
  assert.equal(nulls.n, 0);
  check.close();
  closeDB();
});

test('每个用户只有一个 default space，新用户懒创建', () => {
  const file = tmpDb();
  initDB(file);
  const a = createUser('a', 'x', 'member');
  const b = createUser('b', 'x', 'member');
  const sa = listSpaces(a.id);
  const sb = listSpaces(b.id);
  assert.equal(sa.length, 1);
  assert.equal(sb.length, 1);
  assert.notEqual(sa[0].id, sb[0].id);
  assert.ok(sa[0].is_default && sb[0].is_default);
  assert.equal(ensureDefaultSpace(a.id).id, sa[0].id, '重复调用不新建');
  assert.equal(listSpaces(a.id).length, 1);
  closeDB();
});

test('新文档默认进 default space 根；指定目录后落目录；保存不改变归属', () => {
  const file = tmpDb();
  initDB(file);
  const u = createUser('u', 'x', 'member');
  const def = ensureDefaultSpace(u.id);
  const f = createSpaceFolder(u.id, def.id, '日记');

  const d1 = upsertDoc(u.id, 'root.md', 'R', 'root.md', '# r');
  const d2 = upsertDoc(u.id, 'diary/1.md', '1', '1.md', '# 1', { spaceId: def.id, folderId: f.id });
  const g1 = getDoc(u.id, d1.id)!;
  const g2 = getDoc(u.id, d2.id)!;
  assert.equal(g1.space_id, def.id);
  assert.equal(g1.folder_id, null);
  assert.equal(g2.folder_id, f.id);
  assert.equal(g1.sort_order, 0);
  assert.equal(g2.sort_order, 0, '不同目录各自从 0 开始');

  // 再存一次内容（不传 placement）→ 归属不变
  upsertDoc(u.id, 'diary/1.md', '1', '1.md', '# 改过');
  assert.equal(getDoc(u.id, d2.id)!.folder_id, f.id);
  assert.equal(getDoc(u.id, d2.id)!.space_id, def.id);
  closeDB();
});

test('move：跨目录、跨空间、before/after/position 落位与顺序正确', () => {
  const file = tmpDb();
  initDB(file);
  const u = createUser('u', 'x', 'member');
  const def = ensureDefaultSpace(u.id);
  const s2 = createSpace(u.id, '工作');
  const f1 = createSpaceFolder(u.id, def.id, 'f1');
  const a = upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a').id;
  const b = upsertDoc(u.id, 'b.md', 'B', 'b.md', '# b').id;
  const c = upsertDoc(u.id, 'c.md', 'C', 'c.md', '# c').id;
  assert.deepEqual(
    listAllDocs(u.id).map((d) => d.doc_key),
    ['a.md', 'b.md', 'c.md'],
  );

  // c 放到 a 前面
  moveDoc(u.id, c, { before_id: a });
  assert.deepEqual(
    listSpaceTree(u.id, def.id).docs.map((d) => [d.id, d.sort_order]),
    [
      [c, 0],
      [a, 1],
      [b, 2],
    ],
  );

  // a 放到 b 后面（末尾）
  moveDoc(u.id, a, { after_id: b });
  assert.deepEqual(
    listSpaceTree(u.id, def.id).docs.map((d) => d.id),
    [c, b, a],
  );

  // b 进目录 f1
  const r = moveDoc(u.id, b, { folder_id: f1.id, position: 'end' });
  assert.equal(r.folder_id, f1.id);
  assert.equal(listSpaceTree(u.id, def.id).docs.find((d) => d.id === b)!.folder_id, f1.id);

  // a 搬到另一个空间的根（不给 folder_id → 自动落根）
  const r2 = moveDoc(u.id, a, { space_id: s2.id });
  assert.equal(r2.space_id, s2.id);
  assert.equal(r2.folder_id, null);
  assert.deepEqual(
    listSpaceTree(u.id, def.id).docs.filter((d) => d.folder_id === null).map((d) => d.id),
    [c],
  );
  assert.deepEqual(
    listSpaceTree(u.id, s2.id).docs.map((d) => d.id),
    [a],
  );

  // 锚点不在目标容器 → 400
  assert.throws(() => moveDoc(u.id, a, { space_id: def.id, before_id: c + 999 }), is400);

  // reorder 不能改归属
  assert.throws(() => reorderDoc(u.id, c, { folder_id: f1.id }), is400);
  assert.throws(() => reorderDoc(u.id, c, { space_id: s2.id }), is400);
  reorderDoc(u.id, b, { position: 'start' });
  assert.deepEqual(
    listSpaceTree(u.id, def.id).folders.map((f) => f.id),
    [f1.id],
  );
  assert.deepEqual(
    listSpaceTree(u.id, def.id).docs.filter((d) => d.folder_id === null).map((d) => d.id),
    [c],
    'b 已进目录，根只剩 c',
  );
  assert.deepEqual(
    listSpaceTree(u.id, def.id).docs.filter((d) => d.folder_id === f1.id).map((d) => d.id),
    [b],
  );
  closeDB();
});

test('目录：嵌套/同名/循环/删非空', () => {
  const file = tmpDb();
  initDB(file);
  const u = createUser('u', 'x', 'member');
  const def = ensureDefaultSpace(u.id);
  const p = createSpaceFolder(u.id, def.id, '父');
  const c = createSpaceFolder(u.id, def.id, '子', p.id);
  assert.equal(c.parent_id, p.id);
  assert.throws(() => createSpaceFolder(u.id, def.id, '父', null), is409);
  assert.throws(() => moveSpaceFolder(u.id, p.id, { parent_id: c.id }), is400);
  assert.throws(() => moveSpaceFolder(u.id, p.id, { parent_id: p.id }), is400);

  upsertDoc(u.id, 'p/x.md', 'X', 'x.md', '# x', { spaceId: def.id, folderId: p.id });
  assert.throws(() => deleteSpaceFolder(u.id, p.id), is409, '有子目录/文档时不能删');
  assert.deepEqual(deleteSpaceFolder(u.id, c.id), { ok: true });
  closeDB();
});

test('目录：move 后父级与顺序落定，删目录不静默丢文档', () => {
  const file = tmpDb();
  initDB(file);
  const u = createUser('u', 'x', 'member');
  const def = ensureDefaultSpace(u.id);
  const s2 = createSpace(u.id, '工作');
  const a = createSpaceFolder(u.id, def.id, 'a');
  const b = createSpaceFolder(u.id, def.id, 'b');
  const c = createSpaceFolder(u.id, def.id, 'c');
  assert.deepEqual(
    listSpaceTree(u.id, def.id).folders.map((f) => f.id),
    [a.id, b.id, c.id],
  );
  moveSpaceFolder(u.id, c.id, { before_id: a.id });
  assert.deepEqual(
    listSpaceTree(u.id, def.id).folders.map((f) => f.id),
    [c.id, a.id, b.id],
  );
  moveSpaceFolder(u.id, b.id, { space_id: s2.id, position: 'start' });
  const tree2 = listSpaceTree(u.id, s2.id);
  assert.equal(tree2.folders.length, 1);
  assert.equal(tree2.folders[0].space_id, s2.id);

  // 有文档时拒绝删除，移空后可以删
  const pid = a.id;
  const doc = upsertDoc(u.id, 'a/x.md', 'X', 'x.md', '# x', { spaceId: def.id, folderId: pid });
  assert.throws(() => deleteSpaceFolder(u.id, pid), is409);
  moveDoc(u.id, doc.id, { folder_id: null });
  assert.deepEqual(deleteSpaceFolder(u.id, pid), { ok: true });
  assert.equal(
    listSpaceTree(u.id, def.id).folders.some((f) => f.id === pid),
    false,
  );
  closeDB();
});

test('删除空间：默认空间禁止；非空必须 move_to；空空间可直接删', () => {
  const file = tmpDb();
  initDB(file);
  const u = createUser('u', 'x', 'member');
  const def = ensureDefaultSpace(u.id);
  const s = createSpace(u.id, '临时');
  const f = createSpaceFolder(u.id, s.id, '目录');
  const doc = upsertDoc(u.id, 'tmp/a.md', 'A', 'a.md', '# a', { spaceId: s.id, folderId: f.id });

  assert.throws(() => deleteSpace(u.id, def.id), is400);
  assert.throws(() => deleteSpace(u.id, s.id), is409);

  const r = deleteSpace(u.id, s.id, def.id);
  assert.equal(r.moved_docs, 1);
  const moved = getDoc(u.id, doc.id)!;
  assert.equal(moved.space_id, def.id);
  assert.equal(moved.folder_id, null, '目录不跟随迁移，文档落目标空间根');
  assert.equal(listSpaces(u.id).some((x) => x.id === s.id), false);
  assert.equal(listSpaceTree(u.id, def.id).docs.some((d) => d.id === doc.id), true);

  const empty = createSpace(u.id, '空');
  assert.deepEqual(deleteSpace(u.id, empty.id), { ok: true, moved_docs: 0 });
  closeDB();
});

test('空间重排与改名', () => {
  const file = tmpDb();
  initDB(file);
  const u = createUser('u', 'x', 'member');
  const def = ensureDefaultSpace(u.id);
  const s1 = createSpace(u.id, 'A');
  const s2 = createSpace(u.id, 'B');
  assert.throws(() => createSpace(u.id, 'a'), is409, '同名（忽略大小写）');
  assert.throws(() => createSpace(u.id, 'default'), is409);
  assert.throws(() => renameSpace(u.id, def.id, 'renamed'), is400, '默认空间不能改名');
  renameSpace(u.id, s1.id, 'A2');
  assert.equal(listSpaces(u.id).find((s) => s.id === s1.id)!.name, 'A2');

  reorderSpaces(u.id, [s2.id, def.id, s1.id]);
  assert.deepEqual(
    listSpaces(u.id).map((s) => s.id),
    [s2.id, def.id, s1.id],
  );
  assert.throws(() => reorderSpaces(u.id, [s2.id, def.id]), is400, '必须给全');
  assert.throws(() => reorderSpaces(u.id, [s2.id, def.id, s1.id, 99999]), is400);
  closeDB();
});

test('跨用户不可见：空间/目录/文档/树/删除/移动全部按 user_id 隔离', () => {
  const file = tmpDb();
  initDB(file);
  const a = createUser('a', 'x', 'member');
  const b = createUser('b', 'x', 'member');
  const defA = ensureDefaultSpace(a.id);
  const sA = createSpace(a.id, 'A 的空间');
  const fA = createSpaceFolder(a.id, sA.id, 'A 的目录');
  const docA = upsertDoc(a.id, 'a.md', 'A', 'a.md', '# a', { spaceId: sA.id, folderId: fA.id });

  assert.equal(listSpaces(b.id).some((s) => s.id === sA.id || s.id === defA.id), false);
  assert.equal(listSpaces(b.id).length, 1);
  assert.throws(() => listSpaceTree(b.id, sA.id), is404);
  assert.throws(() => createSpaceFolder(b.id, sA.id, 'x'), is404);
  assert.throws(() => renameSpaceFolder(b.id, fA.id, 'x'), is404);
  assert.throws(() => deleteSpaceFolder(b.id, fA.id), is404);
  assert.throws(() => deleteSpace(b.id, sA.id), is404);
  assert.throws(() => moveSpaceFolder(b.id, fA.id, { space_id: ensureDefaultSpace(b.id).id }), is404);
  assert.throws(() => moveDoc(b.id, docA.id, { folder_id: null }), is404);
  assert.throws(() => reorderDoc(b.id, docA.id, { position: 'start' }), is404);
  assert.throws(() => upsertDoc(b.id, 'x.md', 'X', 'x.md', '# x', { spaceId: sA.id }), is404);

  // A 的文档不能指向 B 的空间 / 目录
  const defB = ensureDefaultSpace(b.id);
  assert.throws(() => moveDoc(a.id, docA.id, { space_id: defB.id }), is404);
  assert.throws(() => moveDoc(a.id, docA.id, { folder_id: null, space_id: sA.id + 9999 }), is404);
  // 目录不属于该空间 → 400（同用户、跨空间）
  assert.throws(() => moveDoc(a.id, docA.id, { space_id: defA.id, folder_id: fA.id }), is400);
  closeDB();
});

// ─── HTTP 层：新路由不被「裸斜杠 doc_key」拦截，PATCH/DELETE/move 都通 ───

function fakeRes(): any {
  const out: any = { statusCode: 200, headers: {}, body: '' };
  out.setHeader = (k: string, v: any) => {
    out.headers[k.toLowerCase()] = v;
  };
  out.end = (chunk?: any) => {
    out.body = chunk == null ? '' : String(chunk);
    return out;
  };
  return out;
}

async function call(mw: any, url: string, method = 'GET', token?: string, body?: unknown) {
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = token ? { cookie: `ptdoc_session=${token}` } : {};
  const res = fakeRes();
  let nexted = false;
  await mw(req, res, () => {
    nexted = true;
  });
  return { res, nexted, json: () => JSON.parse(res.body || '{}') };
}

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-space-api-'));
  closeDB();
  loadServerEnv({ PTDOC_DATA_KEY: 'd'.repeat(64) });
  initDB(join(dir, 'api.db'));
  const user = createUser('api', 'x', 'member');
  const token = 'spacesession';
  insertSession(hashToken(token), user.id, Date.now() + 3600_000);
  return { user, token };
}

test('HTTP：space/folder CRUD + move/reorder 走通，move 不被当成裸斜杠 doc_key', async () => {
  const { user, token } = boot();
  const mw = apiMiddleware() as any;
  assert.equal(hasBareDocKeySlash('/api/docs/12/move'), false);
  assert.equal(hasBareDocKeySlash('/api/docs/12/reorder'), false);

  let r = await call(mw, '/api/spaces', 'GET', token);
  assert.equal(r.res.statusCode, 200, r.res.body);
  const def = r.json().spaces[0];
  assert.equal(def.is_default, 1);

  r = await call(mw, '/api/spaces', 'POST', token, { name: '工作' });
  assert.equal(r.res.statusCode, 200, r.res.body);
  const s2 = r.json();

  r = await call(mw, `/api/spaces/${s2.id}/folders`, 'POST', token, { name: '文档' });
  assert.equal(r.res.statusCode, 200, r.res.body);
  const folder = r.json();

  r = await call(mw, `/api/spaces/${s2.id}/tree`, 'GET', token);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.json().space.id, s2.id);
  assert.equal(r.json().folders.length, 1);

  const d1 = upsertDoc(user.id, 'a.md', 'A', 'a.md', '# a').id;
  const d2 = upsertDoc(user.id, 'b.md', 'B', 'b.md', '# b').id;

  r = await call(mw, `/api/docs/${d1}/move`, 'POST', token, { space_id: s2.id, folder_id: folder.id });
  assert.equal(r.res.statusCode, 200, r.res.body);
  assert.equal(r.json().folder_id, folder.id);

  r = await call(mw, `/api/docs/${d2}/reorder`, 'POST', token, { before_id: d1 });
  assert.equal(r.res.statusCode, 400, '跨容器 reorder 被拦');

  r = await call(mw, `/api/docs/${d2}/move`, 'POST', token, {
    space_id: s2.id,
    folder_id: folder.id,
    before_id: d1,
  });
  assert.equal(r.res.statusCode, 200);
  r = await call(mw, `/api/docs/${d1}/move`, 'POST', token, { after_id: d2 });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.json().sort_order, 1);

  r = await call(mw, `/api/folders/${folder.id}`, 'PATCH', token, { name: '资料' });
  assert.equal(r.res.statusCode, 200);
  r = await call(mw, `/api/folders/${folder.id}/move`, 'POST', token, { position: 'start' });
  assert.equal(r.res.statusCode, 200);
  r = await call(mw, `/api/spaces/${s2.id}`, 'PATCH', token, { name: '工作区' });
  assert.equal(r.res.statusCode, 200);
  r = await call(mw, '/api/spaces/reorder', 'POST', token, { order: [s2.id, def.id] });
  assert.equal(r.res.statusCode, 200);

  r = await call(mw, `/api/spaces/${s2.id}`, 'DELETE', token);
  assert.equal(r.res.statusCode, 409, '非空空间需 move_to');
  r = await call(mw, `/api/spaces/${s2.id}?move_to=${def.id}`, 'DELETE', token);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.json().moved_docs, 2);

  // 未登录 → 401（仍走登录墙）
  r = await call(mw, '/api/spaces', 'GET');
  assert.equal(r.res.statusCode, 401);
  closeDB();
});
