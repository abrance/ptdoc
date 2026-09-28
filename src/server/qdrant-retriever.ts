import { HttpError } from './http.ts';

export interface RetrievedHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  source?: string;
}

export interface QdrantQueryPoint {
  id?: string | number;
  score?: number;
  payload?: Record<string, unknown> | null;
}

export type QdrantQueryFn = (opts: {
  url: string;
  apiKey?: string;
  collection: string;
  query: string;
  limit: number;
  using?: string;
}) => Promise<QdrantQueryPoint[]>;

const TEXT_NOT_ENABLED = '该 collection 未启用服务端向量化';

let queryFn: QdrantQueryFn | null = null;

export function setQdrantQueryForTests(fn: QdrantQueryFn | null): void {
  queryFn = fn;
}

function pickTitle(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return '';
  for (const k of ['title', 'path', 'source', 'url']) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function pickSnippet(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return '';
  for (const k of ['text', 'content', 'page_content', 'body']) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 500);
  }
  return '';
}

export function mapQdrantPoints(points: QdrantQueryPoint[]): RetrievedHit[] {
  return points.map((p, i) => {
    const payload = p.payload || {};
    const title = pickTitle(payload) || String(p.id ?? i);
    return {
      id: String(p.id ?? i),
      title,
      snippet: pickSnippet(payload),
      score: typeof p.score === 'number' ? p.score : 0,
      source: typeof payload.source === 'string' ? payload.source : typeof payload.url === 'string' ? payload.url : undefined,
    };
  });
}

async function defaultQuery(opts: {
  url: string;
  apiKey?: string;
  collection: string;
  query: string;
  limit: number;
  using?: string;
}): Promise<QdrantQueryPoint[]> {
  const base = opts.url.replace(/\/$/, '');
  const body: Record<string, unknown> = { query: opts.query, limit: opts.limit, with_payload: true };
  if (opts.using) body.using = opts.using;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}/collections/${encodeURIComponent(opts.collection)}/points/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { 'api-key': opts.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // 仅在 Qdrant 明确说未启用 inference 时给"未启用"提示；其余情况透传上游错误正文
      //（如 litellm 的向量化校验错误），避免把真实原因吞成误导性文案。
      if (/Service not enabled|inference.*not enabled|not enabled.*inference/i.test(text)) {
        throw new HttpError(400, TEXT_NOT_ENABLED);
      }
      const flat = text.replace(/\s+/g, ' ').trim();
      throw new HttpError(400, '知识库检索失败：' + (flat.slice(0, 200) || 'HTTP ' + res.status));
    }
    const json = JSON.parse(text) as { result?: { points?: QdrantQueryPoint[] } | QdrantQueryPoint[] };
    const result = json.result;
    if (Array.isArray(result)) return result;
    return result?.points || [];
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as Error).name === 'AbortError') throw new HttpError(400, '知识库连接失败');
    throw new HttpError(400, '知识库连接失败');
  } finally {
    clearTimeout(timer);
  }
}

export interface RetrieveProfile {
  url: string;
  apiKey?: string;
  collection: string;
  vectorName?: string;
  topK?: number;
}

export async function retrieveHits(profile: RetrieveProfile, query: string): Promise<RetrievedHit[]> {
  const limit = Math.min(20, Math.max(1, Number(profile.topK) || 5));
  const fn = queryFn || defaultQuery;
  const points = await fn({
    url: profile.url,
    apiKey: profile.apiKey,
    collection: profile.collection,
    query,
    limit,
    using: profile.vectorName || undefined,
  });
  return mapQdrantPoints(points).slice(0, limit);
}
