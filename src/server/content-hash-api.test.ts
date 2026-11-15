import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { closeDB, createUser, initDB, insertSession, upsertDoc } from './db.ts';
import { hashToken } from './auth.ts';
import { loadServerEnv } from './env.ts';
import { apiMiddleware } from './api.ts';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-hash-'));
  closeDB();
  loadServerEnv({ PTDOC_DATA_KEY: 'e'.repeat(64) });
  initDB(join(dir, 'hash.db'));
  const user = createUser('hash', 'x', 'member' as any);
  const token = 'hashtoken';
  insertSession(hashToken(token), user.id, Date.now() + 3600_000);
  return { user, token };
}

async function getJson(url: string, token: string): Promise<{ status: number; json: any }> {
  const req: any = Readable.from([]);
  req.method = 'GET';
  req.url = url;
  req.headers = { cookie: `ptdoc_session=${token}` };
  let status = 200;
  let body = '';
  const res: any = {
    get statusCode() { return status; },
    set statusCode(v: number) { status = v; },
    setHeader: () => {},
    end: (c?: any) => { body = c == null ? '' : String(c); return res; },
  };
  const p = (apiMiddleware() as any)(req, res, () => { status = 404; res.end('{}'); });
  await p;
  return { status, json: JSON.parse(body || '{}') };
}

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

test('FR-31 GET /api/docs/:id 与 /api/docs/full 附只读 content_sha256', async () => {
  const { user, token } = boot();
  const content = '# 标题\n\n正文 😀\n';
  const r = upsertDoc(user.id, 'dir/a.md', 'A', 'a.md', content);

  const one = await getJson(`/api/docs/${r.id}`, token);
  assert.equal(one.status, 200);
  assert.equal(one.json.content_sha256, sha(content), '单篇接口应返回与内容一致的 sha256');
  assert.equal(one.json.content, content, '原有 content 字段不变');

  const full = await getJson('/api/docs/full', token);
  assert.equal(full.status, 200);
  assert.ok(Array.isArray(full.json));
  const row = full.json.find((d: any) => d.doc_key === 'dir/a.md');
  assert.equal(row.content_sha256, sha(content), '全量接口每篇都应带 sha256');
  assert.equal(row.content, content);
  closeDB();
});
