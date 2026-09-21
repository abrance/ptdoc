import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerEnv, resetServerEnvForTests } from './env.ts';
import {
  closeDB,
  createUser,
  initDB,
  insertShare,
  listArchive,
  markQdrantSynced,
  upsertDoc,
  upsertQdrantProfile,
} from './db.ts';
import { encryptSecret } from './storage.ts';
import { HttpError } from './http.ts';
import {
  buildPoints,
  chunkMarkdown,
  pointId,
  setQdrantUpsertForTests,
  toQdrantUpsertPoints,
  upsertArchiveMarkdown,
  upsertAttempts,
} from './qdrant-upsert.ts';
import { syncArchiveToQdrant } from './archive-qdrant.ts';

const GOOD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('chunkMarkdown 短文保持单段，长文按空行切开', () => {
  assert.deepEqual(chunkMarkdown('hello'), ['hello']);
  const a = 'a'.repeat(800);
  const b = 'b'.repeat(800);
  const chunks = chunkMarkdown(a + '\n\n' + b, 1200);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], a);
  assert.equal(chunks[1], b);
});

test('pointId 对同一文档同一段稳定', () => {
  assert.equal(pointId(1, 'a.md', 0), pointId(1, 'a.md', 0));
  assert.notEqual(pointId(1, 'a.md', 0), pointId(1, 'a.md', 1));
});

test('buildPoints 写入 title/path/text payload', () => {
  const points = buildPoints(
    {
      url: 'http://q',
      collection: 'c',
      userId: 3,
      docKey: 'notes.md',
      title: 'Notes',
      archivePath: 'proj/notes.md',
      mdUrl: 'https://qiniu/x.md',
      htmlUrl: 'https://qiniu/x.html',
      markdown: 'hello',
    },
    ['hello'],
  );
  assert.equal(points.length, 1);
  assert.equal(points[0].text, 'hello');
  assert.equal(points[0].payload.title, 'Notes');
  assert.equal(points[0].payload.path, 'proj/notes.md');
  assert.equal(points[0].payload.doc_key, 'notes.md');
});

test('upsertArchiveMarkdown 走注入 client，空文不写点', async () => {
  const seen: unknown[] = [];
  setQdrantUpsertForTests(async (opts) => {
    seen.push(opts.points);
  });
  const r = await upsertArchiveMarkdown({
    url: 'http://q',
    collection: 'c',
    userId: 1,
    docKey: 'a.md',
    title: 'A',
    archivePath: 'a.md',
    mdUrl: null,
    htmlUrl: 'https://x',
    markdown: '   ',
  });
  assert.equal(r.chunks, 0);
  assert.deepEqual(seen, [[]]);
  setQdrantUpsertForTests(null);
});

test('同步成功后 listArchive.qdrant_sync 为 synced，新分享后变 stale', async () => {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: GOOD });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
  const u = createUser('alice', 'hash', 'member');
  const d = upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a');
  insertShare(u.id, 'a.md', '# a', [], undefined, 'https://qiniu.example/a.html');
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'none');
  upsertQdrantProfile(u.id, 'http://q', encryptSecret('k'), 'col', null, 5);
  setQdrantUpsertForTests(async () => {});
  const r = await syncArchiveToQdrant(u.id, d.id);
  assert.equal(r.qdrant_sync, 'synced');
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'synced');
  insertShare(u.id, 'a.md', '# a2', [], undefined, 'https://qiniu.example/a2.html');
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'stale');
  markQdrantSynced(u.id, d.id, listArchive(u.id).entries[0].share_id);
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'synced');
  setQdrantUpsertForTests(null);
  closeDB();
});

test('toQdrantUpsertPoints 无 vector 名时写入 Document text', () => {
  const pts = toQdrantUpsertPoints([{ id: '1', text: 'hello', payload: { a: 1 } }]);
  assert.deepEqual(pts[0].vector, { text: 'hello' });
  assert.equal(pts[0].payload.a, 1);
  assert.ok(!('text' in pts[0]));
});

test('toQdrantUpsertPoints 有 vector 名时用 named Document', () => {
  const pts = toQdrantUpsertPoints([{ id: '1', text: 'hello', payload: {} }], 'dense');
  assert.deepEqual(pts[0].vector, { dense: { text: 'hello' } });
});

test('upsertAttempts 依次给出 inference / document / text 三种格式', () => {
  const points = [{ id: '1', text: 'hello', payload: { a: 1 } }];
  const attempts = upsertAttempts(points);
  assert.deepEqual(
    attempts.map((a) => a.kind),
    ['inference', 'document', 'text'],
  );
  const gateway = attempts[1].body.points as Array<Record<string, unknown>>;
  assert.equal(gateway[0].document, 'hello');
  assert.equal(gateway[0].text, undefined);
  assert.equal(attempts[1].body.using, undefined);
  assert.equal(upsertAttempts(points, 'dense')[1].body.using, 'dense');
});

const SAMPLE_UPSERT = {
  url: 'http://qdrant.example',
  collection: 'col',
  userId: 1,
  docKey: 'a.md',
  title: 'A',
  archivePath: 'a.md',
  mdUrl: null as string | null,
  htmlUrl: 'https://x',
  markdown: 'hello',
};

async function withMockFetch(
  handler: (url: string, method: string, body: Record<string, unknown>) => { status: number; body: string },
  run: () => Promise<void>,
): Promise<Array<{ url: string; method: string; body: Record<string, unknown> }>> {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method || 'GET');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method, body });
    const r = handler(url, method, body);
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
    setQdrantUpsertForTests(null);
  }
  return calls;
}

test('defaultUpsert 发送 vector.text 而不是顶层 text', async () => {
  setQdrantUpsertForTests(null);
  const calls = await withMockFetch(
    () => ({ status: 200, body: '{"status":"ok"}' }),
    async () => {
      await upsertArchiveMarkdown(SAMPLE_UPSERT);
    },
  );
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put);
  const points = (put!.body.points as Array<Record<string, unknown>>)[0];
  assert.deepEqual(points.vector, { text: 'hello' });
  assert.equal(points.text, undefined);
});

test('defaultUpsert 带 vectorName 时写入 named Document', async () => {
  setQdrantUpsertForTests(null);
  const calls = await withMockFetch(
    () => ({ status: 200, body: '{"status":"ok"}' }),
    async () => {
      await upsertArchiveMarkdown({ ...SAMPLE_UPSERT, vectorName: 'dense' });
    },
  );
  const put = calls.find((c) => c.method === 'PUT');
  const points = (put!.body.points as Array<Record<string, unknown>>)[0];
  assert.deepEqual(points.vector, { dense: { text: 'hello' } });
});

test('inference 格式被拒后回退网关的 document 字段', async () => {
  setQdrantUpsertForTests(null);
  let puts = 0;
  const calls = await withMockFetch(
    (_url, method) => {
      if (method === 'PUT') {
        puts += 1;
        if (puts === 1) {
          return {
            status: 422,
            body: 'Failed to deserialize the JSON body into the target type: points[0]: missing field `document`',
          };
        }
        return { status: 200, body: '{"status":"ok"}' };
      }
      return { status: 200, body: '{"status":"ok"}' };
    },
    async () => {
      await upsertArchiveMarkdown(SAMPLE_UPSERT);
    },
  );
  const putsCalls = calls.filter((c) => c.method === 'PUT');
  assert.equal(putsCalls.length, 2);
  const point = (putsCalls[1].body.points as Array<Record<string, unknown>>)[0];
  assert.equal(point.document, 'hello');
  assert.equal(point.text, undefined);
  assert.equal(point.vector, undefined);
});

test('document 也被拒后回退旧网关的 text 字段', async () => {
  setQdrantUpsertForTests(null);
  const calls = await withMockFetch(
    (_url, method, body) => {
      if (method !== 'PUT') return { status: 200, body: '{}' };
      const point = (body.points as Array<Record<string, unknown>>)[0];
      if (point.text !== undefined) return { status: 200, body: '{"status":"ok"}' };
      return { status: 400, body: '{"status":{"error":"unknown field `document`"}}' };
    },
    async () => {
      await upsertArchiveMarkdown(SAMPLE_UPSERT);
    },
  );
  const putsCalls = calls.filter((c) => c.method === 'PUT');
  assert.equal(putsCalls.length, 3);
  assert.equal((putsCalls[2].body.points as Array<Record<string, unknown>>)[0].text, 'hello');
});

test('三种格式都失败时报错带上游原因', async () => {
  setQdrantUpsertForTests(null);
  await assert.rejects(
    () =>
      withMockFetch(
        () => ({ status: 400, body: '{"status":{"error":"unknown field `text`"}}' }),
        async () => {
          await upsertArchiveMarkdown(SAMPLE_UPSERT);
        },
      ),
    (err: unknown) =>
      err instanceof HttpError &&
      err.message.startsWith('知识库写入失败：') &&
      err.message.includes('unknown field `text`'),
  );
});

test('真正未启用 inference 时仍报服务端向量化', async () => {
  setQdrantUpsertForTests(null);
  await assert.rejects(
    () =>
      withMockFetch(
        (_url, method) => {
          if (method === 'PUT') {
            return { status: 400, body: '{"status":{"error":"inference is not enabled for this collection"}}' };
          }
          return { status: 200, body: '{}' };
        },
        async () => {
          await upsertArchiveMarkdown(SAMPLE_UPSERT);
        },
      ),
    (err: unknown) => err instanceof HttpError && err.message === '该 collection 未启用服务端向量化',
  );
});

test('同步把 profile.vector_name 传给 upsert', async () => {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: GOOD });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
  const u = createUser('bob', 'hash', 'member');
  const d = upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a');
  insertShare(u.id, 'a.md', '# a', [], undefined, 'https://qiniu.example/a.html');
  upsertQdrantProfile(u.id, 'http://q', encryptSecret('k'), 'col', 'dense', 5);
  let seen: string | undefined;
  setQdrantUpsertForTests(async (opts) => {
    seen = opts.vectorName;
  });
  await syncArchiveToQdrant(u.id, d.id);
  assert.equal(seen, 'dense');
  setQdrantUpsertForTests(null);
  closeDB();
});
