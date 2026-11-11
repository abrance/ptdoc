import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { closeDB, createUser, initDB, insertSession, upsertDoc } from './db.ts';
import { hashToken } from './auth.ts';
import { loadServerEnv } from './env.ts';
import { archiveApiMiddleware } from './archive-api.ts';

// 回归护栏：GET /api/archive 曾只返回 {items}，侧边栏归档树读 {entries,folders} 就报「加载失败」。
function fakeRes(): any {
  const out: any = { statusCode: 200, headers: {}, body: '' };
  out.setHeader = (k: string, v: any) => {
    out.headers[k.toLowerCase()] = v;
  };
  out.end = (chunk?: any) => {
    out.body = chunk == null ? '' : String(chunk);
    return out;
  };
  out.writeHead = (code: number) => {
    out.statusCode = code;
    return out;
  };
  return out;
}

test('GET /api/archive 同时返回 items 与侧边栏要的 entries/folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-shape-'));
  closeDB();
  loadServerEnv({ PTDOC_DATA_KEY: 'c'.repeat(64) });
  initDB(join(dir, 'shape.db'));
  const user = createUser('shape', 'x', 'member' as any);
  const token = 'shapetoken';
  insertSession(hashToken(token), user.id, Date.now() + 3600_000);
  upsertDoc(user.id, 'dir/a.md', 'A', '', '# A\n');

  const req: any = Readable.from([]);
  req.method = 'GET';
  req.url = '/api/archive';
  req.headers = { cookie: `ptdoc_session=${token}` };
  const res = fakeRes();
  let nexted = false;
  await (archiveApiMiddleware() as any)(req, res, () => {
    nexted = true;
  });

  assert.equal(nexted, false, '应由 archive-api 处理，不落到下一个中间件');
  if (!res.body) {
    assert.fail('空响应，status=' + res.statusCode);
  }
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.items), 'items 给归档产物列表');
  assert.ok(Array.isArray(body.entries), 'entries 给侧边栏归档树');
  assert.ok(Array.isArray(body.folders), 'folders 给归档目录树');
  closeDB();
});
