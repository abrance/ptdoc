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
}

export type QdrantUpsertFn = (opts: {
  url: string;
  apiKey?: string;
  collection: string;
  points: TextPoint[];
  docKey: string;
  userId: number;
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

  const put = await qdrantJson(opts.url, opts.apiKey, 'PUT', `/collections/${col}/points?wait=true`, {
    points: opts.points,
  });
  if (!put.ok) {
    if (put.status === 400 || /inference|embedding|text query|document|unknown field/i.test(put.text)) {
      throw new HttpError(400, TEXT_NOT_ENABLED);
    }
    throw new HttpError(400, '知识库写入失败');
  }
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
  });
  return { chunks: points.length };
}
