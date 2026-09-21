import { createHash } from 'node:crypto';
import { HttpError } from './http.ts';

export interface TextPoint {
  id: string;
  text: string;
  payload: Record<string, unknown>;
}

export interface UpsertArchiveOpts {
  url: string;
  apiKey?: string;
  collection: string;
  userId: number;
  docKey: string;
  title: string;
  archivePath: string;
  mdUrl: string | null;
  htmlUrl: string;
  markdown: string;
  vectorName?: string;
}

export type QdrantUpsertFn = (opts: {
  url: string;
  apiKey?: string;
  collection: string;
  points: TextPoint[];
  docKey: string;
  userId: number;
  vectorName?: string;
}) => Promise<void>;

const TEXT_NOT_ENABLED = '该 collection 未启用服务端向量化';

let upsertFn: QdrantUpsertFn | null = null;

export function setQdrantUpsertForTests(fn: QdrantUpsertFn | null): void {
  upsertFn = fn;
}

export function chunkMarkdown(md: string, maxLen = 1200): string[] {
  const text = md.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const blocks = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const b of blocks) {
    if (b.length > maxLen) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      for (let i = 0; i < b.length; i += maxLen) chunks.push(b.slice(i, i + maxLen));
      continue;
    }
    if (buf && buf.length + 2 + b.length > maxLen) {
      chunks.push(buf);
      buf = b;
    } else {
      buf = buf ? buf + '\n\n' + b : b;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function pointId(userId: number, docKey: string, index: number): string {
  const h = createHash('sha256').update(`ptdoc:${userId}:${docKey}:${index}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function buildPoints(opts: UpsertArchiveOpts, chunks: string[]): TextPoint[] {
  return chunks.map((text, i) => ({
    id: pointId(opts.userId, opts.docKey, i),
    text,
    payload: {
      title: opts.title,
      path: opts.archivePath,
      source: opts.mdUrl || opts.htmlUrl,
      url: opts.htmlUrl,
      text,
      doc_key: opts.docKey,
      user_id: opts.userId,
      chunk_index: i,
    },
  }));
}

/** Qdrant Cloud Inference / FastEmbed: Document `{ text }` lets the collection embed server-side. */
export function toQdrantUpsertPoints(
  points: TextPoint[],
  vectorName?: string,
): Array<{ id: string; vector: Record<string, unknown>; payload: Record<string, unknown> }> {
  const name = vectorName?.trim();
  return points.map((p) => {
    const document = { text: p.text };
    return {
      id: p.id,
      vector: name ? { [name]: document } : document,
      payload: p.payload,
    };
  });
}

/**
 * ptdoc 自建网关（ptdoc-qdrant-gateway）契约：点里放顶层 `document` 字符串，
 * 由网关用本地模型向量化后再写入 Qdrant；命名向量走顶层 `using`。
 */
export function toGatewayUpsertPoints(
  points: TextPoint[],
): Array<{ id: string; document: string; payload: Record<string, unknown> }> {
  return points.map((p) => ({ id: p.id, document: p.text, payload: p.payload }));
}

/** 旧版网关兼容：顶层 `text`。 */
export function toTextUpsertPoints(
  points: TextPoint[],
): Array<{ id: string; text: string; payload: Record<string, unknown> }> {
  return points.map((p) => ({ id: p.id, text: p.text, payload: p.payload }));
}

export interface UpsertAttempt {
  kind: 'inference' | 'document' | 'text';
  body: Record<string, unknown>;
}

/**
 * 写入格式按部署形态依次尝试：
 * 1. `inference`：Qdrant Cloud 服务端向量化的 Document `{ text }`；
 * 2. `document`：ptdoc 网关（本地 FastEmbed）契约；
 * 3. `text`：旧版网关兼容格式。
 */
export function upsertAttempts(points: TextPoint[], vectorName?: string): UpsertAttempt[] {
  const name = vectorName?.trim();
  const gateway: Record<string, unknown> = { points: toGatewayUpsertPoints(points) };
  if (name) gateway.using = name;
  return [
    { kind: 'inference', body: { points: toQdrantUpsertPoints(points, vectorName) } },
    { kind: 'document', body: gateway },
    { kind: 'text', body: { points: toTextUpsertPoints(points) } },
  ];
}

function isJsonFormatError(text: string): boolean {
  return /unknown field|deserialize|json body|format error|expected one of/i.test(text);
}

/** 截断上游错误正文，便于在前端直接看到失败原因。 */
function shortError(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat;
}

function isInferenceDisabledError(text: string): boolean {
  if (isJsonFormatError(text)) return false;
  return /inference|embedding|text query|document|fastembed|vectorization|not enabled/i.test(text);
}

async function qdrantJson(
  url: string,
  apiKey: string | undefined,
  method: string,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; text: string }> {
  const base = url.replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'api-key': apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new HttpError(400, '知识库连接失败');
    throw new HttpError(400, '知识库连接失败');
  } finally {
    clearTimeout(timer);
  }
}

async function defaultUpsert(opts: {
  url: string;
  apiKey?: string;
  collection: string;
  points: TextPoint[];
  docKey: string;
  userId: number;
  vectorName?: string;
 }): Promise<void> {
  const col = encodeURIComponent(opts.collection);
  await qdrantJson(opts.url, opts.apiKey, 'POST', `/collections/${col}/points/delete?wait=true`, {
    filter: {
      must: [
        { key: 'doc_key', match: { value: opts.docKey } },
        { key: 'user_id', match: { value: opts.userId } },
      ],
    },
  }).catch(() => ({ ok: true, status: 0, text: '' }));

  if (opts.points.length === 0) return;

  const putPath = `/collections/${col}/points?wait=true`;
  const failures: Array<{ kind: UpsertAttempt['kind']; status: number; text: string }> = [];
  for (const attempt of upsertAttempts(opts.points, opts.vectorName)) {
    const res = await qdrantJson(opts.url, opts.apiKey, 'PUT', putPath, attempt.body);
    if (res.ok) return;
    failures.push({ kind: attempt.kind, status: res.status, text: res.text });
  }

  console.warn(
    '[qdrant] upsert failed',
    failures.map((f) => `${f.kind} ${f.status} ${shortError(f.text)}`).join(' | '),
  );

  if (failures.some((f) => isInferenceDisabledError(f.text))) {
    throw new HttpError(400, TEXT_NOT_ENABLED);
  }
  const last = failures[failures.length - 1];
  const detail = last && last.text.trim() ? `：${shortError(last.text)}` : '';
  throw new HttpError(400, `知识库写入失败${detail}`);
}

export async function upsertArchiveMarkdown(opts: UpsertArchiveOpts): Promise<{ chunks: number }> {
  const chunks = chunkMarkdown(opts.markdown);
  const points = buildPoints(opts, chunks);
  const fn = upsertFn || defaultUpsert;
  await fn({
    url: opts.url,
    apiKey: opts.apiKey,
    collection: opts.collection,
    points,
    docKey: opts.docKey,
    userId: opts.userId,
    vectorName: opts.vectorName,
  });
  return { chunks: points.length };
}
