import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { closeDB, createUser, initDB, insertSession, upsertDoc } from './db.ts';
import { hashToken } from './auth.ts';
import { loadServerEnv } from './env.ts';
import { apiMiddleware } from './api.ts';
import { archiveApiMiddleware } from './archive-api.ts';

// FR-25：GET /api/docs/ops/a.md/archive-status 曾落到 GET /api/docs 列表路由，返回 200 + 文档列表。

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

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-api-'));
  closeDB();
  loadServerEnv({ PTDOC_DATA_KEY: 'd'.repeat(64) });
  initDB(join(dir, 'api.db'));
  const user = createUser('api', 'x', 'member' as any);
  const token = 'apitoken';
  insertSession(hashToken(token), user.id, Date.now() + 3600_000);
  return { user, token };
}

async function call(mw: any, url: string, method = 'GET', token?: string) {
  const req: any = Readable.from([]);
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

test('FR-25 裸斜杠 doc_key：两个入口都 400 + 转义提示，不再返回文档列表', async () => {
  const { token } = boot();
  for (const mw of [apiMiddleware(), archiveApiMiddleware()]) {
    const { res, nexted, json } = await call(mw as any, '/api/docs/ops/a.md/archive-status', 'GET', token);
    assert.equal(nexted, false, '应当直接拒绝，不再落到后续中间件');
    assert.equal(res.statusCode, 400);
    assert.match(json().error, /URL 转义/);
    assert.match(json().error, /ops%2Fa\.md/);
  }
  closeDB();
});

test('FR-25 转义后的 doc_key 仍是 200（原有行为不变）', async () => {
  const { user, token } = boot();
  upsertDoc(user.id, 'ops/a.md', 'A', '', '# A\n');
  const { res, json } = await call(archiveApiMiddleware() as any, '/api/docs/ops%2Fa.md/archive-status', 'GET', token);
  assert.equal(res.statusCode, 200);
  assert.equal(json().version, 0, '未归档文档的 archive-status 仍是 version 0');
  closeDB();
});

test('FR-25 单段/纯数字 id/列表路由行为不变，多段合法路由不被误伤', async () => {
  const { user, token } = boot();
  const doc = upsertDoc(user.id, 'plain.md', 'p', '', '# p\n');
  const mw = apiMiddleware() as any;

  const one = await call(mw, `/api/docs/${doc.id}`, 'GET', token);
  assert.equal(one.res.statusCode, 200);
  assert.equal(one.json().doc_key, 'plain.md');

  const list = await call(mw, '/api/docs?q=plain', 'GET', token);
  assert.equal(list.res.statusCode, 200);
  assert.ok(Array.isArray(list.json()));

  // 合法多段子路由（:id/snapshots）不能被裸斜杠判定误伤
  const snaps = await call(mw, `/api/docs/${doc.id}/snapshots`, 'GET', token);
  assert.equal(snaps.res.statusCode, 200);
  assert.ok(Array.isArray(snaps.json()));
  closeDB();
});
