import type { Connect } from 'vite';
import { uploadToQiniu } from './qiniu-uploader';
import { getStorageProfile, initDB, insertMedia } from './db';
import { requireUser } from './auth';
import { requireUserStorage } from './storage';
import { HttpError, sendJson } from './http';

function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function uploadMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/upload')) return next();

    try {
      initDB();
      const user = requireUser(req, res);
      if (req.method === 'GET') {
        const row = getStorageProfile(user.id);
        return sendJson(res, 200, { configured: !!(row && row.verified_at) });
      }
      if (req.method !== 'POST') return next();

      const cfg = requireUserStorage(user.id);
      const buf = await readBody(req);
      const rawName = String(req.headers['x-filename'] || 'image.png');
      const filename = decodeURIComponent(rawName);
      const keyPrefix = typeof req.headers['x-key-prefix'] === 'string' ? req.headers['x-key-prefix'] : undefined;
      const source =
        req.headers['x-source'] === 'mermaid'
          ? 'mermaid'
          : req.headers['x-source'] === 'share'
            ? 'share'
            : 'direct';
      const result = await uploadToQiniu(cfg, buf, filename, keyPrefix);
      if (source !== 'share') insertMedia(user.id, result.key, result.url, filename, source, buf.length);
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}
