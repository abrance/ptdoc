import type { Connect } from 'vite';
import { uploadToQiniu, isQiniuConfigured } from './qiniu-uploader';
import { initDB, insertMedia } from './db';

function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: import('http').ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/**
 * 图床上传接口（仅在 dev / preview 服务端生效，密钥不进前端）：
 *   GET  /api/upload        -> { configured: boolean }
 *   POST /api/upload        -> { url, key }
 *      body: 图片二进制（application/octet-stream）
 *      header: X-Filename   -> 原始文件名（用于决定扩展名）
 *      header: X-Key-Prefix -> 资源前缀（'md-img' 默认 / 'share'）
 *      header: X-Source     -> 来源（'direct' 默认 / 'mermaid' / 'share'），媒体库仅收录 direct/mermaid
 * 上传成功后写入 media 表（媒体库数据源）。
 */
export function uploadMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/upload')) return next();

    if (req.method === 'GET') {
      return sendJson(res, 200, { configured: isQiniuConfigured() });
    }
    if (req.method !== 'POST') return next();

    try {
      initDB();
      const buf = await readBody(req);
      const rawName = String(req.headers['x-filename'] || 'image.png');
      const filename = decodeURIComponent(rawName);
      const keyPrefix = typeof req.headers['x-key-prefix'] === 'string' ? req.headers['x-key-prefix'] : undefined;
      // 分享版产物（.md/.html）与图片分开：直接上传的图片才进媒体库，避免非图片文件
      // 在媒体库里显示成坏缩略图、或被误删导致分享链接失效。
      const source =
        req.headers['x-source'] === 'mermaid'
          ? 'mermaid'
          : req.headers['x-source'] === 'share'
            ? 'share'
            : 'direct';
      const result = await uploadToQiniu(buf, filename, keyPrefix);
      if (source !== 'share') insertMedia(result.key, result.url, filename, source, buf.length);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}
