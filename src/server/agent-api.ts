import type { Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from './http.ts';
import { requireAdmin, requireUser } from './auth.ts';
import { decryptSecret, encryptSecret } from './storage.ts';
import {
  createAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  getAgentTraceByTurn,
  getAgentTurn,
  getDoc,
  getDocByKey,
  getLlmProfile,
  getQdrantProfile,
  initDB,
  insertAgentTrace,
  insertAgentTurn,
  listAgentConversations,
  listAgentTurns,
  touchAgentConversation,
  upsertDoc,
  upsertLlmProfile,
  upsertQdrantProfile,
} from './db.ts';
import { retrieveHits } from './qdrant-retriever.ts';
import { lineDiff } from './draft-diff.ts';
import {
  createMcp,
  createPlugin,
  createSkill,
  getExtensionOrThrow,
  listEnabledSummaries,
  listExtensions,
  removeExtension,
  setEnabled,
  toPublicExtension,
  updateMcp,
  updatePlugin,
  updateSkill,
} from './extension-store.ts';
import { newTraceId, runChat } from './agent-runtime.ts';

const aborts = new Map<string, AbortController>();

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(url: string): string {
  return url.split('?')[0];
}

function queryOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

function clampTopK(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 5;
  return Math.min(20, Math.max(1, Math.round(v)));
}

async function readZipUpload(req: IncomingMessage, body?: any): Promise<{ name: string; zip: Buffer }> {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json') || body) {
    const b = body || (await readJson(req));
    const name = String(b.name || req.headers['x-name'] || '').trim();
    const raw = String(b.zip_base64 || '');
    if (!raw) throw new HttpError(400, '缺少 zip_base64');
    return { name, zip: Buffer.from(raw, 'base64') };
  }
  const name = String(req.headers['x-name'] || '').trim();
  const zip = await readBody(req);
  if (!zip.length) throw new HttpError(400, '缺少 zip 内容');
  return { name, zip };
}

function writeSse(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function agentApiMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = req.url || '';
    if (!url.startsWith('/api/agents') && !url.startsWith('/api/admin/extensions')) return next();
    try {
      initDB();
      const user = requireUser(req, res);
      const path = pathOf(url);

      if (path.startsWith('/api/admin/extensions')) {
        requireAdmin(user);
        return await handleAdmin(req, res, path);
      }
      return await handleUser(req, res, user.id, path, url);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === '/api/admin/extensions' && req.method === 'GET') {
    const q = queryOf(req.url || '');
    return sendJson(res, 200, listExtensions(q.get('kind') || undefined, q.get('q') || undefined));
  }
  const one = path.match(/^\/api\/admin\/extensions\/(\d+)$/);
  if (one && req.method === 'GET') {
    return sendJson(res, 200, toPublicExtension(getExtensionOrThrow(Number(one[1]))));
  }
  if (one && req.method === 'DELETE') {
    removeExtension(Number(one[1]));
    return sendJson(res, 200, { ok: true });
  }
  const en = path.match(/^\/api\/admin\/extensions\/(\d+)\/enable$/);
  if (en && req.method === 'POST') return sendJson(res, 200, setEnabled(Number(en[1]), true));
  const dis = path.match(/^\/api\/admin\/extensions\/(\d+)\/disable$/);
  if (dis && req.method === 'POST') return sendJson(res, 200, setEnabled(Number(dis[1]), false));

  if (path === '/api/admin/extensions/mcp' && req.method === 'POST') {
    return sendJson(res, 200, await createMcp(await readJson(req)));
  }
  const mcp = path.match(/^\/api\/admin\/extensions\/mcp\/(\d+)$/);
  if (mcp && req.method === 'PUT') {
    return sendJson(res, 200, await updateMcp(Number(mcp[1]), await readJson(req)));
  }

  if (path === '/api/admin/extensions/skills' && req.method === 'POST') {
    const up = await readZipUpload(req);
    return sendJson(res, 200, await createSkill(up.name, up.zip));
  }
  const sk = path.match(/^\/api\/admin\/extensions\/skills\/(\d+)$/);
  if (sk && req.method === 'PUT') {
    const up = await readZipUpload(req);
    return sendJson(res, 200, await updateSkill(Number(sk[1]), up.name, up.zip));
  }
  if (path === '/api/admin/extensions/plugins' && req.method === 'POST') {
    const up = await readZipUpload(req);
    return sendJson(res, 200, await createPlugin(up.name, up.zip));
  }
  const pl = path.match(/^\/api\/admin\/extensions\/plugins\/(\d+)$/);
  if (pl && req.method === 'PUT') {
    const up = await readZipUpload(req);
    return sendJson(res, 200, await updatePlugin(Number(pl[1]), up.name, up.zip));
  }
  throw new HttpError(404, '扩展不存在');
}

async function handleUser(
  req: IncomingMessage,
  res: ServerResponse,
  uid: number,
  path: string,
  url: string,
): Promise<void> {
  if (path === '/api/agents/llm' && req.method === 'GET') {
    const row = getLlmProfile(uid);
    return sendJson(res, 200, {
      base_url: row?.base_url || '',
      model: row?.model || '',
      secret_configured: !!row,
    });
  }
  if (path === '/api/agents/llm' && req.method === 'PUT') {
    const b = await readJson(req);
    const baseUrl = String(b.base_url || '').trim();
    const model = String(b.model || '').trim();
    const keyBody = typeof b.api_key === 'string' ? b.api_key.trim() : '';
    const existing = getLlmProfile(uid);
    const key = keyBody || (existing ? decryptSecret(existing.api_key_enc) : '');
    if (!baseUrl || !model || !key) throw new HttpError(400, '请填写大模型 Base URL、API Key 与模型名');
    upsertLlmProfile(uid, baseUrl, encryptSecret(key), model);
    return sendJson(res, 200, { base_url: baseUrl, model, secret_configured: true });
  }

  if (path === '/api/agents/qdrant' && req.method === 'GET') {
    const row = getQdrantProfile(uid);
    return sendJson(res, 200, {
      url: row?.url || '',
      collection: row?.collection || '',
      vector_name: row?.vector_name || '',
      top_k: row?.top_k || 5,
      secret_configured: !!(row && row.api_key_enc),
    });
  }
  if (path === '/api/agents/qdrant' && req.method === 'PUT') {
    const b = await readJson(req);
    const qurl = String(b.url || '').trim();
    const collection = String(b.collection || '').trim();
    if (!qurl || !collection) throw new HttpError(400, '请填写 Qdrant URL 与 collection');
    const existing = getQdrantProfile(uid);
    const keyBody = typeof b.api_key === 'string' ? b.api_key.trim() : '';
    let enc: string | null = existing?.api_key_enc || null;
    if (keyBody) enc = encryptSecret(keyBody);
    const vectorName = b.vector_name ? String(b.vector_name).trim() : null;
    upsertQdrantProfile(uid, qurl, enc, collection, vectorName, clampTopK(b.top_k));
    return sendJson(res, 200, {
      url: qurl,
      collection,
      vector_name: vectorName || '',
      top_k: clampTopK(b.top_k),
      secret_configured: !!enc,
    });
  }

  if (path === '/api/agents/extensions' && req.method === 'GET') {
    const user = requireUser(req, res);
    if (user.role === 'admin') return sendJson(res, 200, listExtensions());
    return sendJson(res, 200, listEnabledSummaries());
  }

  if (path === '/api/agents/conversations' && req.method === 'GET') {
    const scene = queryOf(url).get('scene') || undefined;
    if (scene && scene !== 'qa' && scene !== 'writer') throw new HttpError(400, 'scene 仅支持 qa 或 writer');
    return sendJson(res, 200, listAgentConversations(uid, scene));
  }
  if (path === '/api/agents/conversations' && req.method === 'POST') {
    const b = await readJson(req);
    const scene = String(b.scene || '');
    if (scene !== 'qa' && scene !== 'writer') throw new HttpError(400, 'scene 仅支持 qa 或 writer');
    return sendJson(res, 200, createAgentConversation(uid, scene));
  }

  const conv = path.match(/^\/api\/agents\/conversations\/(\d+)$/);
  if (conv && req.method === 'GET') {
    const id = Number(conv[1]);
    const c = getAgentConversation(uid, id);
    if (!c) throw new HttpError(403, '权限不足');
    return sendJson(res, 200, { ...c, turns: listAgentTurns(uid, id) });
  }
  if (conv && req.method === 'DELETE') {
    const id = Number(conv[1]);
    if (!deleteAgentConversation(uid, id)) throw new HttpError(403, '权限不足');
    return sendJson(res, 200, { ok: true });
  }

  const chat = path.match(/^\/api\/agents\/conversations\/(\d+)\/chat$/);
  if (chat && req.method === 'POST') {
    return await handleChat(req, res, uid, Number(chat[1]));
  }

  const stop = path.match(/^\/api\/agents\/conversations\/(\d+)\/stop$/);
  if (stop && req.method === 'POST') {
    const key = uid + ':' + stop[1];
    aborts.get(key)?.abort();
    return sendJson(res, 200, { ok: true });
  }

  const handoff = path.match(/^\/api\/agents\/conversations\/(\d+)\/handoff$/);
  if (handoff && req.method === 'POST') {
    const cid = Number(handoff[1]);
    const b = await readJson(req);
    const turn = getAgentTurn(uid, cid, Number(b.turn_id));
    if (!turn) throw new HttpError(403, '权限不足');
    const src = getAgentConversation(uid, cid);
    if (!src || src.scene !== 'qa') throw new HttpError(400, '只能从问答会话交接');
    const hits = getAgentTraceByTurn(uid, cid, turn.id);
    const packed = [
      '【交接自知识库问答】',
      '问题与回答：',
      turn.content,
      hits?.hits_json ? '检索命中：\n' + hits.hits_json : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const dest = createAgentConversation(uid, 'writer', '交接编写');
    insertAgentTurn({ conversation_id: dest.id, user_id: uid, role: 'user', content: packed });
    return sendJson(res, 200, { writer_conversation_id: dest.id });
  }

  const apply = path.match(/^\/api\/agents\/conversations\/(\d+)\/apply-draft$/);
  if (apply && req.method === 'POST') {
    const cid = Number(apply[1]);
    if (!getAgentConversation(uid, cid)) throw new HttpError(403, '权限不足');
    const b = await readJson(req);
    const content = String(b.content || '');
    const mode = String(b.mode || '');
    if (mode === 'replace-current') {
      const doc = getDoc(uid, Number(b.doc_id));
      if (!doc) throw new HttpError(400, '文档不存在');
      return sendJson(res, 200, upsertDoc(uid, doc.doc_key, doc.title, doc.filename, content));
    }
    if (mode === 'create') {
      const key = String(b.doc_key || '').trim();
      if (!key) throw new HttpError(400, 'doc_key 不能为空');
      if (getDocByKey(uid, key)) throw new HttpError(409, '文档标识已存在');
      const filename = key.slice(key.lastIndexOf('/') + 1);
      return sendJson(res, 200, upsertDoc(uid, key, filename, filename, content));
    }
    throw new HttpError(400, 'mode 无效');
  }

  const diff = path.match(/^\/api\/agents\/conversations\/(\d+)\/draft-diff$/);
  if (diff && (req.method === 'GET' || req.method === 'POST')) {
    if (!getAgentConversation(uid, Number(diff[1]))) throw new HttpError(403, '权限不足');
    let content = '';
    let target: string | null = null;
    if (req.method === 'POST') {
      const b = await readJson(req);
      content = String(b.content || '');
      target = b.target_doc_id != null ? String(b.target_doc_id) : null;
    } else {
      const q = queryOf(url);
      content = q.get('content') || '';
      target = q.get('target_doc_id');
    }
    let oldText = '';
    if (target) {
      const doc = getDoc(uid, Number(target));
      if (doc) oldText = doc.content;
    }
    return sendJson(res, 200, { hunks: lineDiff(oldText, content) });
  }

  const trace = path.match(/^\/api\/agents\/conversations\/(\d+)\/turns\/(\d+)\/trace$/);
  if (trace && req.method === 'GET') {
    const row = getAgentTraceByTurn(uid, Number(trace[1]), Number(trace[2]));
    if (!row) throw new HttpError(404, 'Trace 不存在');
    return sendJson(res, 200, {
      ...row,
      hits: row.hits_json ? JSON.parse(row.hits_json) : [],
      spans: row.spans_json ? JSON.parse(row.spans_json) : [],
    });
  }

  const retrieve = path.match(/^\/api\/agents\/conversations\/(\d+)\/retrieve$/);
  if (retrieve && req.method === 'POST') {
    if (!getAgentConversation(uid, Number(retrieve[1]))) throw new HttpError(403, '权限不足');
    const profile = getQdrantProfile(uid);
    if (!profile) throw new HttpError(400, '请先在设置中填写 Qdrant URL 与 collection');
    const b = await readJson(req);
    const hits = await retrieveHits(
      {
        url: profile.url,
        apiKey: profile.api_key_enc ? decryptSecret(profile.api_key_enc) : undefined,
        collection: profile.collection,
        vectorName: profile.vector_name || undefined,
        topK: profile.top_k,
      },
      String(b.query || ''),
    );
    return sendJson(res, 200, { hits });
  }

  throw new HttpError(404, '接口不存在');
}

async function handleChat(req: IncomingMessage, res: ServerResponse, uid: number, cid: number): Promise<void> {
  const conv = getAgentConversation(uid, cid);
  if (!conv) throw new HttpError(403, '权限不足');
  if (!getLlmProfile(uid)) throw new HttpError(400, '请先在设置中填写大模型 Base URL、API Key 与模型名');
  if (conv.scene === 'qa' && !getQdrantProfile(uid)) {
    throw new HttpError(400, '请先在设置中填写 Qdrant URL 与 collection');
  }
  const b = await readJson(req);
  const input = String(b.input || '').trim();
  if (!input) throw new HttpError(400, '输入不能为空');
  const docId = b.doc_id != null ? Number(b.doc_id) : undefined;
  insertAgentTurn({ conversation_id: cid, user_id: uid, role: 'user', content: input });
  const history = listAgentTurns(uid, cid)
    .slice(0, -1)
    .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content }));
  const key = uid + ':' + cid;
  aborts.get(key)?.abort();
  const ac = new AbortController();
  aborts.set(key, ac);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const t0 = Date.now();
  const gen = runChat({
    userId: uid,
    scene: conv.scene as 'qa' | 'writer',
    messages: history,
    input,
    docId,
    abort: ac.signal,
  });
  let result = await gen.next();
  while (!result.done) {
    writeSse(res, result.value);
    result = await gen.next();
  }
  const out = result.value;
  const traceId = newTraceId();
  const assistant = insertAgentTurn({
    conversation_id: cid,
    user_id: uid,
    role: 'assistant',
    content: out.text,
    draft_md: out.draft || null,
    trace_id: traceId,
  });
  insertAgentTrace({
    trace_id: traceId,
    user_id: uid,
    conversation_id: cid,
    turn_id: assistant.id,
    model: out.model,
    input_tokens: out.inputTokens,
    output_tokens: out.outputTokens,
    latency_ms: Date.now() - t0,
    hits_json: JSON.stringify(out.hits || []),
    spans_json: JSON.stringify(out.spans || []),
    created_at: Date.now(),
  });
  if (!conv.title) touchAgentConversation(uid, cid, input.slice(0, 40));
  else touchAgentConversation(uid, cid);
  writeSse(res, { type: 'data-done', data: { turn_id: assistant.id, trace_id: traceId } });
  writeSse(res, { type: 'finish' });
  res.write('data: [DONE]\n\n');
  res.end();
  aborts.delete(key);
}
