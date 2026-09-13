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
