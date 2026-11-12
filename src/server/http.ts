import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export function readJson(req: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export const SESSION_COOKIE = 'ptdoc_session';

export const DOC_KEY_PATH_ERROR = 'doc_key 作为路径参数需 URL 转义（ops/a.md → ops%2Fa.md）';

/**
 * /api/docs/<doc_ref> 之后允许出现的尾段（与 api.ts / archive-api.ts 已实现的路由一一对应）。
 * 新增 /api/docs/:id/* 子路由时必须把尾段加进这里，否则那条路由会被当成裸斜杠 doc_key 直接 400。
 */
const DOC_REF_TAILS_RE =
  /^(?:rename|archive|archive-status|archive\/rotate-token|archive-path|qdrant-sync|snapshots(?:\/\d+)?(?:\/restore)?|versions(?:\/\d+)?(?:\/restore)?)$/;

/**
 * doc_key 作为路径参数时出现裸斜杠（多段）→ 匹配不到任何 :id 路由，会静默落进 GET /api/docs 列表接口。
 * 只判结构，不解析 doc_key；转义形式（ops%2Fa.md）仍是单段，照旧放行。
 */
export function hasBareDocKeySlash(url: string): boolean {
  const path = (url || '').split('?')[0];
  if (!path.startsWith('/api/docs/')) return false;
  const segs = path.slice('/api/docs/'.length).split('/');
  // 纯尾斜杠 /api/docs/ 是 1 段空串，会落进列表接口，同样是裸斜杠形态
  if (segs.length === 1 && path.endsWith('/')) return true;
  if (segs.length < 2) return false;
  return !DOC_REF_TAILS_RE.test(segs.slice(1).join('/'));
}

export function setSessionCookie(res: ServerResponse, token: string, maxAgeSec: number): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`,
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}
