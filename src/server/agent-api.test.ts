import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { loadServerEnv, resetServerEnvForTests } from './env.ts';
import { closeDB, createUser, initDB, upsertDoc, getDocByKey } from './db.ts';
import { hashPassword, issueSession } from './auth.ts';
import { agentApiMiddleware } from './agent-api.ts';
import { setChatRunnerForTests } from './agent-runtime.ts';
import { setExtensionsRootForTests, setPluginInstallerForTests } from './extension-store.ts';
import { encryptSecret } from './storage.ts';
import { upsertLlmProfile, upsertQdrantProfile } from './db.ts';

const GOOD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function boot(): void {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: GOOD });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
  setExtensionsRootForTests(mkdtempSync(join(tmpdir(), 'ext-')));
  setPluginInstallerForTests(() => {});
  setChatRunnerForTests(async function* (input) {
    yield { type: 'text-delta', delta: 'ok:' + input.input };
    return {
      text: 'ok:' + input.input,
      hits: [{ id: '1', title: 't', snippet: 's', score: 1 }],
      spans: [{ name: 'search_knowledge', ms: 3, ok: true }],
      model: 'fake',
      inputTokens: 1,
      outputTokens: 2,
    };
  });
}

function tokenFor(userId: number): string {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  res.setHeader = (() => res) as typeof res.setHeader;
  return issueSession(res, userId);
}

async function call(opts: {
  method: string;
  url: string;
  token: string;
  body?: unknown;
}): Promise<{ status: number; json: any; text: string }> {
  const mw = agentApiMiddleware();
  const req = new IncomingMessage(new Socket());
  req.method = opts.method;
  req.url = opts.url;
  req.headers = {
    cookie: 'ptdoc_session=' + opts.token,
    'content-type': 'application/json',
  };
  const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : null;
  const chunks: Buffer[] = [];
  let status = 200;
  const res = new ServerResponse(req);
  Object.defineProperty(res, 'statusCode', {
    get: () => status,
    set: (v) => {
      status = v;
    },
    configurable: true,
  });
  res.setHeader = (() => res) as typeof res.setHeader;
  res.write = ((c: any) => {
    chunks.push(Buffer.from(c));
    return true;
  }) as typeof res.write;
  const done = new Promise<{ status: number; json: any; text: string }>((resolve) => {
    res.end = ((c?: any) => {
      if (c) chunks.push(Buffer.from(c));
      const text = Buffer.concat(chunks).toString('utf8');
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      resolve({ status, json, text });
      return res;
    }) as typeof res.end;
  });
  const p = mw(req, res, () => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'next' }));
  });
  queueMicrotask(() => {
    if (payload) req.emit('data', payload);
    req.emit('end');
  });
  await p;
  return done;
}

test('无 LLM Profile 时 chat 返回 400', async () => {
  boot();
  const u = createUser('alice', hashPassword('password1'), 'member');
  const tok = tokenFor(u.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: tok, body: { scene: 'writer' } });
  const r = await call({
    method: 'POST',
    url: `/api/agents/conversations/${conv.json.id}/chat`,
    token: tok,
    body: { input: 'hi' },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /大模型/);
  closeDB();
});

test('qa 场景无 Qdrant Profile 返回 400', async () => {
  boot();
  const u = createUser('alice', hashPassword('password1'), 'member');
  upsertLlmProfile(u.id, 'http://llm', encryptSecret('sk'), 'm');
  const tok = tokenFor(u.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: tok, body: { scene: 'qa' } });
  const r = await call({
    method: 'POST',
    url: `/api/agents/conversations/${conv.json.id}/chat`,
    token: tok,
    body: { input: 'hi' },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Qdrant/);
  closeDB();
});

test('Member 写扩展 403；Admin 创建 MCP 200', async () => {
  boot();
  const member = createUser('bob', hashPassword('password1'), 'member');
  const admin = createUser('root', hashPassword('password1'), 'admin');
  const m = await call({
    method: 'POST',
    url: '/api/admin/extensions/mcp',
    token: tokenFor(member.id),
    body: { name: 'x', transport: 'http', url: 'http://x' },
  });
  assert.equal(m.status, 403);
  const a = await call({
    method: 'POST',
    url: '/api/admin/extensions/mcp',
    token: tokenFor(admin.id),
    body: { name: 'x', transport: 'http', url: 'http://x' },
  });
  assert.equal(a.status, 200);
  assert.equal(a.json.name, 'x');
  assert.equal('api_key' in a.json, false);
  closeDB();
});

test('apply-draft 未调用时 docs 不变；replace-current 后等于草稿；create 冲突 409', async () => {
  boot();
  const u = createUser('alice', hashPassword('password1'), 'member');
  upsertDoc(u.id, 'notes/a.md', 'A', 'a.md', '# old');
  const tok = tokenFor(u.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: tok, body: { scene: 'writer' } });
  const before = getDocByKey(u.id, 'notes/a.md')!;
  assert.equal(before.content, '# old');
  const doc = before;
  const ok = await call({
    method: 'POST',
    url: `/api/agents/conversations/${conv.json.id}/apply-draft`,
    token: tok,
    body: { mode: 'replace-current', doc_id: doc.id, content: '# new' },
  });
  assert.equal(ok.status, 200);
  assert.equal(getDocByKey(u.id, 'notes/a.md')!.content, '# new');
  const conflict = await call({
    method: 'POST',
    url: `/api/agents/conversations/${conv.json.id}/apply-draft`,
    token: tok,
    body: { mode: 'create', doc_key: 'notes/a.md', content: '# x' },
  });
  assert.equal(conflict.status, 409);
  closeDB();
});

test('Conversation/Trace 用另一 user 读取 403；LLM GET 无 api_key', async () => {
  boot();
  const a = createUser('a1', hashPassword('password1'), 'member');
  const b = createUser('b1', hashPassword('password1'), 'member');
  upsertLlmProfile(a.id, 'http://llm', encryptSecret('sk-secret'), 'm');
  upsertQdrantProfile(a.id, 'http://q', encryptSecret('qk'), 'col', null, 5);
  const ta = tokenFor(a.id);
  const tb = tokenFor(b.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: ta, body: { scene: 'qa' } });
  const stolen = await call({
    method: 'GET',
    url: `/api/agents/conversations/${conv.json.id}`,
    token: tb,
  });
  assert.equal(stolen.status, 403);
  const llm = await call({ method: 'GET', url: '/api/agents/llm', token: ta });
  assert.equal(llm.json.secret_configured, true);
  assert.equal('api_key' in llm.json, false);
  const qd = await call({ method: 'GET', url: '/api/agents/qdrant', token: ta });
  assert.equal('api_key' in qd.json, false);
  closeDB();
});

test('chat 流式结束后 Trace 含 hits 与 spans', async () => {
  boot();
  const u = createUser('alice', hashPassword('password1'), 'member');
  upsertLlmProfile(u.id, 'http://llm', encryptSecret('sk'), 'm');
  upsertQdrantProfile(u.id, 'http://q', null, 'col', null, 5);
  const tok = tokenFor(u.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: tok, body: { scene: 'qa' } });
  const chat = await call({
    method: 'POST',
    url: `/api/agents/conversations/${conv.json.id}/chat`,
    token: tok,
    body: { input: 'hello' },
  });
  assert.equal(chat.status, 200);
  assert.match(chat.text, /text-delta/);
  const detail = await call({
    method: 'GET',
    url: `/api/agents/conversations/${conv.json.id}`,
    token: tok,
  });
  const turn = detail.json.turns.find((t: any) => t.role === 'assistant');
  const tr = await call({
    method: 'GET',
    url: `/api/agents/conversations/${conv.json.id}/turns/${turn.id}/trace`,
    token: tok,
  });
  assert.equal(tr.status, 200);
  assert.ok(Array.isArray(tr.json.hits));
  assert.ok(Array.isArray(tr.json.spans));
  closeDB();
});

test('失败 turn 标记 error + thinking 落库 + data-done 摘要（FR-07/11/12）', async () => {
  boot();
  setChatRunnerForTests(async function* (input) {
    yield { type: 'thinking-delta', delta: '想想…' };
    yield { type: 'thinking-end' };
    yield { type: 'error', errorText: '上游 500' };
    return { text: '', hits: [], spans: [], model: 'fake', inputTokens: 1, outputTokens: 1 };
  });
  const u = createUser('alice', hashPassword('password1'), 'member');
  upsertLlmProfile(u.id, 'http://llm', encryptSecret('sk'), 'm', 'high');
  upsertQdrantProfile(u.id, 'http://q', null, 'col', null, 5);
  const tok = tokenFor(u.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: tok, body: { scene: 'qa' } });
  const chat = await call({
    method: 'POST',
    url: `/api/agents/conversations/${conv.json.id}/chat`,
    token: tok,
    body: { input: 'hi' },
  });
  assert.match(chat.text, /thinking-delta/);
  const doneEv = chat.text.split('\n\n').map((l) => l.replace(/^data: /, '')).filter((l) => l && l !== '[DONE]').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === 'data-done');
  assert.equal(doneEv.data.status, 'error');
  assert.equal(doneEv.data.error_message, '上游 500');
  assert.ok(doneEv.data.model, 'data-done 应带模型名');
  assert.ok(doneEv.data.latency_ms >= 0, 'data-done 应带耗时');
  // turn 落库带 status/error_message
  const detail = await call({ method: 'GET', url: `/api/agents/conversations/${conv.json.id}`, token: tok });
  const turn = detail.json.turns.find((t: any) => t.role === 'assistant');
  assert.equal(turn.status, 'error');
  assert.equal(turn.error_message, '上游 500');
  closeDB();
});

test('retry：删除失败轮并重跑成功（FR-11）', async () => {
  boot();
  setChatRunnerForTests(async function* (input) {
    yield { type: 'error', errorText: '第一次失败' };
    return { text: '', hits: [], spans: [], model: 'fake', inputTokens: 0, outputTokens: 0 };
  });
  const u = createUser('alice', hashPassword('password1'), 'member');
  upsertLlmProfile(u.id, 'http://llm', encryptSecret('sk'), 'm', 'high');
  upsertQdrantProfile(u.id, 'http://q', null, 'col', null, 5);
  const tok = tokenFor(u.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: tok, body: { scene: 'qa' } });
  await call({ method: 'POST', url: `/api/agents/conversations/${conv.json.id}/chat`, token: tok, body: { input: '问题A' } });
  let detail = await call({ method: 'GET', url: `/api/agents/conversations/${conv.json.id}`, token: tok });
  const failed = detail.json.turns.find((t: any) => t.role === 'assistant');
  assert.equal(failed.status, 'error');
  // 切换 runner 为成功，重试
  setChatRunnerForTests(async function* (input) {
    yield { type: 'text-delta', delta: '重试成功:' + input.input };
    return { text: '重试成功:' + input.input, hits: [], spans: [], model: 'fake', inputTokens: 1, outputTokens: 1 };
  });
  const retry = await call({ method: 'POST', url: `/api/agents/conversations/${conv.json.id}/turns/${failed.id}/retry`, token: tok });
  assert.equal(retry.status, 200);
  assert.match(retry.text, /重试成功:问题A/);
  detail = await call({ method: 'GET', url: `/api/agents/conversations/${conv.json.id}`, token: tok });
  const assts = detail.json.turns.filter((t: any) => t.role === 'assistant');
  assert.equal(assts.length, 1, '失败轮应被删除，只剩重试成功轮');
  assert.equal(assts[0].status, 'ok');
  assert.match(assts[0].content, /重试成功:问题A/);
  closeDB();
});

test('steer：流式期间 chat 只入队返回 queued（FR-10）', async () => {
  boot();
  // 挂起 runner：等待释放信号，模拟长流式
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  setChatRunnerForTests(async function* (input) {
    yield { type: 'text-delta', delta: '开始' };
    await gate;
    return { text: '开始', hits: [], spans: [], model: 'fake', inputTokens: 0, outputTokens: 0 };
  });
  const u = createUser('alice', hashPassword('password1'), 'member');
  upsertLlmProfile(u.id, 'http://llm', encryptSecret('sk'), 'm', 'high');
  upsertQdrantProfile(u.id, 'http://q', null, 'col', null, 5);
  const tok = tokenFor(u.id);
  const conv = await call({ method: 'POST', url: '/api/agents/conversations', token: tok, body: { scene: 'qa' } });
  // 第一个 chat 手动驱动：发出请求但不等待完成
  const chatPromise = call({ method: 'POST', url: `/api/agents/conversations/${conv.json.id}/chat`, token: tok, body: { input: '第一问' } });
  await new Promise((r) => setTimeout(r, 30));
  // 流式期间第二次 chat → queued
  const q = await call({ method: 'POST', url: `/api/agents/conversations/${conv.json.id}/chat`, token: tok, body: { input: '追问B' } });
  assert.equal(q.status, 200);
  assert.equal(q.json.queued, true);
  release();
  const chat = await chatPromise;
  assert.match(chat.text, /text-delta/);
  closeDB();
});
