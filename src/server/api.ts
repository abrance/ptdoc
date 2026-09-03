import type { Connect } from 'vite';
import { buildShareHtmlDoc } from '../core/share-html';
import { deleteFromQiniu } from './qiniu-uploader';
import {
  initDB,
  upsertDoc,
  getDoc,
  searchDocs,
  listAllDocs,
  listAllDocsFull,
  renameDoc,
  deleteDoc,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
  insertShare,
  listShares,
  getShare,
  deleteShare,
  updateShareHtmlUrl,
  listShareImages,
  getMermaidCache,
  putMermaidCache,
  listMedia,
  getMedia,
  deleteMediaRecord,
} from './db';

function readJson(req: NodeJS.ReadableStream): Promise<any> {
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

function sendJson(res: import('http').ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/**
 * 文档/分享的 REST 接口（仅在 dev / preview 服务端生效）：
 *   GET  /api/docs?q=     -> 搜索（有 q）/ 列出全部文档（无 q，供文档树）
 *   GET  /api/docs/full   -> 全部文档全文（含 content，供全文搜索索引）
 *   GET  /api/docs/:id    -> 取某篇文档全文
 *   POST /api/docs        -> 保存/更新一篇文档（自动记录历史；doc_key 可为路径）
 *   POST /api/docs/:id/rename -> 重命名文档（级联更新 shares 引用）
 *   DELETE /api/docs/:id  -> 删除文档（级联删 shares/images/版本快照）
 *   POST /api/docs/:id/snapshots            -> 存快照 { label? }
 *   GET  /api/docs/:id/snapshots            -> 快照列表
 *   POST /api/docs/:id/snapshots/:sid/restore -> 恢复快照到当前内容
 *   DELETE /api/docs/:id/snapshots/:sid     -> 删除快照
 *   POST /api/share       -> 记录一次分享版生成（md 文本 + 图片映射 + .md/.html 永久链接）
 *   POST /api/share/:id/html -> 上传分享版 HTML 成功后回写永久链接
 *   GET  /api/share/:id   -> 单条分享详情（含 share_md，供「查看 MD」）
 *   GET  /api/share?doc_key= -> 列出某文档的分享记录
 *   DELETE /api/share/:id  -> 删除分享记录（不影响七牛上的 HTML/图片）
 *   GET  /api/media?q=&source= -> 媒体库列表（source: direct|mermaid）
 *   DELETE /api/media/:id  -> 删除图床对象 + 媒体库记录
 */
export function apiMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = req.url || '';
    if (
      !url.startsWith('/api/docs') &&
      !url.startsWith('/api/share') &&
      !url.startsWith('/api/mermaid-cache') &&
      !url.startsWith('/api/media') &&
      !url.startsWith('/s/')
    )
      return next();

    try {
      initDB();

      // —— 托管分享页：GET /s/:id（实时渲染 share_md，仅 dev/preview 可用）——
      const sharePageMatch = url.match(/^\/s\/(\d+)(?:\?.*)?$/);
      if (sharePageMatch && req.method === 'GET') {
        const share = getShare(Number(sharePageMatch[1]));
        if (!share) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(buildShareHtmlDoc(share.share_md));
        return;
      }

      // —— 版本快照 ——
      const snapMatch = url.match(/^\/api\/docs\/(\d+)\/snapshots$/);
      if (snapMatch && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, createSnapshot(Number(snapMatch[1]), b.label));
      }
      if (snapMatch && req.method === 'GET') {
        return sendJson(res, 200, listSnapshots(Number(snapMatch[1])));
      }
      const restoreMatch = url.match(/^\/api\/docs\/(\d+)\/snapshots\/(\d+)\/restore$/);
      if (restoreMatch && req.method === 'POST') {
        return sendJson(res, 200, restoreSnapshot(Number(restoreMatch[1]), Number(restoreMatch[2])));
      }
      const snapDelMatch = url.match(/^\/api\/docs\/(\d+)\/snapshots\/(\d+)$/);
      if (snapDelMatch && req.method === 'DELETE') {
        return sendJson(res, 200, deleteSnapshot(Number(snapDelMatch[2])));
      }

      // —— 文档 ——
      if (url === '/api/docs' && req.method === 'POST') {
        const b = await readJson(req);
        const r = upsertDoc(b.doc_key, b.title ?? '', b.filename ?? '', b.content ?? '');
        return sendJson(res, 200, r);
      }
      // 全文列表（含 content，供前端全文搜索建索引）
      if (url === '/api/docs/full' && req.method === 'GET') {
        return sendJson(res, 200, listAllDocsFull());
      }
      // 重命名：POST /api/docs/:id/rename { new_key }（级联更新 shares 引用）
      if (url.startsWith('/api/docs/') && url.endsWith('/rename') && req.method === 'POST') {
        const id = Number(url.slice('/api/docs/'.length).split('/')[0]);
        const b = await readJson(req);
        return sendJson(res, 200, renameDoc(id, b.new_key));
      }
      // 删除：DELETE /api/docs/:id（级联删 shares/images/doc_versions）
      if (url.startsWith('/api/docs/') && req.method === 'DELETE') {
        const id = Number(url.slice('/api/docs/'.length).split('?')[0]);
        return sendJson(res, 200, deleteDoc(id));
      }
      const docIdMatch = url.match(/^\/api\/docs\/(\d+)(?:\?.*)?$/);
      if (docIdMatch && req.method === 'GET') {
        const doc = getDoc(Number(docIdMatch[1]));
        if (!doc) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, doc);
      }
      if (url.startsWith('/api/docs') && req.method === 'GET') {
        const q = new URL(url, 'http://localhost').searchParams.get('q') || '';
        // 无 q 时返回全部（供侧边栏文档树）；有 q 时走搜索
        const list = q ? searchDocs(q) : listAllDocs();
        return sendJson(res, 200, list);
      }

      // —— 分享记录 ——
      if (url === '/api/share' && req.method === 'POST') {
        const b = await readJson(req);
        const r = insertShare(
          b.doc_key ?? null,
          b.share_md ?? '',
          b.images ?? [],
          b.md_url,
          b.html_url,
        );
        return sendJson(res, 200, r);
      }
      // 上传分享版 HTML 成功后回写永久链接（POST /api/share/:id/html）
      const htmlMatch = url.match(/^\/api\/share\/(\d+)\/html$/);
      if (htmlMatch && req.method === 'POST') {
        const b = await readJson(req);
        updateShareHtmlUrl(Number(htmlMatch[1]), b.html_url ?? '');
        return sendJson(res, 200, { ok: true });
      }
      // 单条分享详情（含 share_md 与图片映射，供「查看 MD」与发布一致性检查）：GET /api/share/:id
      const shareGetMatch = url.match(/^\/api\/share\/(\d+)$/);
      if (shareGetMatch && req.method === 'GET') {
        const s = getShare(Number(shareGetMatch[1]));
        if (!s) return sendJson(res, 404, { error: '分享记录不存在' });
        return sendJson(res, 200, { ...s, images: listShareImages(Number(shareGetMatch[1])) });
      }
      if (url.startsWith('/api/share') && req.method === 'GET') {
        const dk = new URL(url, 'http://localhost').searchParams.get('doc_key') || undefined;
        return sendJson(res, 200, listShares(dk));
      }
      // 删除分享记录（不影响七牛上已上传的 HTML/图片）：DELETE /api/share/:id
      const shareDelMatch = url.match(/^\/api\/share\/(\d+)$/);
      if (shareDelMatch && req.method === 'DELETE') {
        const id = Number(shareDelMatch[1]);
        if (!getShare(id)) return sendJson(res, 404, { error: '分享记录不存在' });
        return sendJson(res, 200, deleteShare(id));
      }

      // —— 媒体库 ——
      const mediaListMatch = url.match(/^\/api\/media(?:\?.*)?$/);
      if (mediaListMatch && req.method === 'GET') {
        const u = new URL(url, 'http://localhost');
        const q = u.searchParams.get('q') || undefined;
        const source = u.searchParams.get('source') || undefined;
        return sendJson(res, 200, listMedia(q, source));
      }
      const mediaDelMatch = url.match(/^\/api\/media\/(\d+)$/);
      if (mediaDelMatch && req.method === 'DELETE') {
        const media = getMedia(Number(mediaDelMatch[1]));
        if (!media) return sendJson(res, 404, { error: '媒体记录不存在' });
        // 先删七牛对象（失败则抛错→500，记录保留），再删本地记录
        await deleteFromQiniu(media.qiniu_key);
        deleteMediaRecord(media.id);
        return sendJson(res, 200, { ok: true });
      }

      // —— mermaid -> 已上传图片 缓存（去重）——
      if (url === '/api/mermaid-cache' && req.method === 'GET') {
        return sendJson(res, 200, getMermaidCache());
      }
      if (url === '/api/mermaid-cache' && req.method === 'POST') {
        const b = await readJson(req);
        putMermaidCache(b.hash, b.key, b.url);
        return sendJson(res, 200, { ok: true });
      }

      return next();
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}
