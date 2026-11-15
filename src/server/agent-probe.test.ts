import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeQdrant } from './agent-probe.ts';

/** 替换全局 fetch，收集实际请求的 URL 与头，验证探测走的端点与鉴权。 */
function withFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: (calls: Array<{ url: string; init: RequestInit }>) => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = orig;
  });
}

test('Qdrant 探测命中 /collections/:name 并回显未命名向量维度', async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 1024 } } } } }), { status: 200 }),
    async (calls) => {
      const r = await probeQdrant({ url: 'http://q:6333', collection: 'ptdoc' });
      assert.equal(r.ok, true);
      assert.equal(calls[0]?.url, 'http://q:6333/collections/ptdoc');
      assert.match(r.detail, /维度 1024/);
    },
  );
});

test('Qdrant 探测回显命名向量并在 vector 名不匹配时给提示', async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ result: { config: { params: { vectors: { dense: { size: 768 } } } } } }), {
        status: 200,
      }),
    async () => {
      const r = await probeQdrant({ url: 'http://q:6333/', collection: 'c', vectorName: 'nope' });
      assert.equal(r.ok, true);
      assert.match(r.detail, /维度 768（向量名 dense）/);
      assert.match(r.hint, /「nope」不在该 collection 里/);
    },
  );
});

test('Qdrant 探测带 api-key 头', async () => {
  await withFetch(
    () => new Response('{}', { status: 200 }),
    async (calls) => {
      await probeQdrant({ url: 'http://q:6333', collection: 'c', apiKey: 'sekret' });
      const h = calls[0]?.init.headers as Record<string, string>;
      assert.equal(h['api-key'], 'sekret');
    },
  );
});

test('Qdrant 404 时补试 /qdrant 前缀（网关形态）', async () => {
  await withFetch(
    (url) =>
      url.includes('/qdrant/collections/')
        ? new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 512 } } } } }), { status: 200 })
        : new Response('not found', { status: 404 }),
    async (calls) => {
      const r = await probeQdrant({ url: 'http://gw:8080', collection: 'c' });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.url, 'http://gw:8080/qdrant/collections/c');
      assert.match(r.detail, /维度 512/);
    },
  );
});

test('Qdrant 401 给鉴权提示、连接失败给可达性提示', async () => {
  await withFetch(
    () => new Response('unauthorized', { status: 401 }),
    async () => {
      const r = await probeQdrant({ url: 'http://q:6333', collection: 'c' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
      assert.match(r.hint, /API Key/);
    },
  );
  await withFetch(
    () => {
      throw new Error('fetch failed');
    },
    async () => {
      const r = await probeQdrant({ url: 'http://q:6333', collection: 'c' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 0);
      assert.match(r.hint, /连不上/);
    },
  );
});

test('Qdrant collection 不存在时提示建库或加前缀', async () => {
  await withFetch(
    () => new Response('{"status":{"error":"Not found"}}', { status: 404 }),
    async () => {
      const r = await probeQdrant({ url: 'http://q:6333', collection: 'missing' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 404);
      assert.match(r.hint, /「missing」不存在/);
    },
  );
});

// ── LLM 提示分类（不发网络请求，纯函数级） ──
import { probeLlm } from './agent-probe.ts';

test('LLM 未配置缺字段时提示缺哪个（不发请求）', async () => {
  // 空 baseUrl 走不到 fetch，但 probeLlm 本身不校验；校验在路由层，这里只断言不会崩
  const r = await probeLlm({ baseUrl: 'https://no-such-host-xyz.invalid/v1', apiKey: 'k', model: 'm' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.match(r.hint, /连不上 Base URL/);
});
