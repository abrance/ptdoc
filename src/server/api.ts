import type { Connect } from 'vite';
import { buildShareHtmlDoc } from '../core/share-html';
import { deleteFromQiniu } from './qiniu-uploader';
import { requireUserStorage } from './storage';
import { HttpError, readJson, sendJson } from './http';
import { requireUser } from './auth';
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
  getStorageProfile,
} from './db';
import { parseStorageInput, saveVerifiedProfile, toPublicProfile, verifyConnectivity } from './storage';

/**
 * 文档/分享/媒体/存储 REST 接口。除公开静态资源外均需登录，数据按 Current User 隔离。
 */
export function apiMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = req.url || '';
    if (
      !url.startsWith('/api/docs') &&
      !url.startsWith('/api/share') &&
      !url.startsWith('/api/mermaid-cache') &&
      !url.startsWith('/api/media') &&
      !url.startsWith('/api/storage') &&
      !url.startsWith('/s/')
    )
      return next();

    try {
      initDB();
      const user = requireUser(req, res);
      const uid = user.id;

      const sharePageMatch = url.match(/^\/s\/(\d+)(?:\?.*)?$/);
      if (sharePageMatch && req.method === 'GET') {
        const share = getShare(uid, Number(sharePageMatch[1]));
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

      if (url === '/api/storage' && req.method === 'GET') {
        return sendJson(res, 200, toPublicProfile(getStorageProfile(uid)));
      }
      if (url === '/api/storage/test' && req.method === 'POST') {
        const b = await readJson(req);
        const cfg = parseStorageInput(b, getStorageProfile(uid));
        await verifyConnectivity(cfg);
        return sendJson(res, 200, { ok: true });
      }
      if (url === '/api/storage' && req.method === 'PUT') {
        const b = await readJson(req);
        const cfg = parseStorageInput(b, getStorageProfile(uid));
        const saved = await saveVerifiedProfile(uid, cfg);
        return sendJson(res, 200, saved);
      }

      const snapMatch = url.match(/^\/api\/docs\/(\d+)\/snapshots$/);
      if (snapMatch && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, createSnapshot(uid, Number(snapMatch[1]), b.label));
      }
      if (snapMatch && req.method === 'GET') {
        return sendJson(res, 200, listSnapshots(uid, Number(snapMatch[1])));
      }
      const restoreMatch = url.match(/^\/api\/docs\/(\d+)\/snapshots\/(\d+)\/restore$/);
      if (restoreMatch && req.method === 'POST') {
        return sendJson(res, 200, restoreSnapshot(uid, Number(restoreMatch[1]), Number(restoreMatch[2])));
      }
      const snapDelMatch = url.match(/^\/api\/docs\/(\d+)\/snapshots\/(\d+)$/);
      if (snapDelMatch && req.method === 'DELETE') {
        return sendJson(res, 200, deleteSnapshot(uid, Number(snapDelMatch[2])));
      }

      if (url === '/api/docs' && req.method === 'POST') {
        const b = await readJson(req);
        const r = upsertDoc(uid, b.doc_key, b.title ?? '', b.filename ?? '', b.content ?? '');
        return sendJson(res, 200, r);
      }
      if (url === '/api/docs/full' && req.method === 'GET') {
        return sendJson(res, 200, listAllDocsFull(uid));
      }
      if (url.startsWith('/api/docs/') && url.endsWith('/rename') && req.method === 'POST') {
        const id = Number(url.slice('/api/docs/'.length).split('/')[0]);
        const b = await readJson(req);
        return sendJson(res, 200, renameDoc(uid, id, b.new_key));
      }
      if (url.startsWith('/api/docs/') && req.method === 'DELETE') {
        const id = Number(url.slice('/api/docs/'.length).split('?')[0]);
        return sendJson(res, 200, deleteDoc(uid, id));
      }
      const docIdMatch = url.match(/^\/api\/docs\/(\d+)(?:\?.*)?$/);
      if (docIdMatch && req.method === 'GET') {
        const doc = getDoc(uid, Number(docIdMatch[1]));
        if (!doc) return sendJson(res, 404, { error: '不存在' });
        return sendJson(res, 200, doc);
      }
      if (url.startsWith('/api/docs') && req.method === 'GET') {
        const q = new URL(url, 'http://localhost').searchParams.get('q') || '';
        const list = q ? searchDocs(uid, q) : listAllDocs(uid);
        return sendJson(res, 200, list);
      }

      if (url === '/api/share' && req.method === 'POST') {
        const b = await readJson(req);
        const r = insertShare(uid, b.doc_key ?? null, b.share_md ?? '', b.images ?? [], b.md_url, b.html_url);
        return sendJson(res, 200, r);
      }
      const htmlMatch = url.match(/^\/api\/share\/(\d+)\/html$/);
      if (htmlMatch && req.method === 'POST') {
        const b = await readJson(req);
        updateShareHtmlUrl(uid, Number(htmlMatch[1]), b.html_url ?? '');
        return sendJson(res, 200, { ok: true });
      }
      const shareGetMatch = url.match(/^\/api\/share\/(\d+)$/);
      if (shareGetMatch && req.method === 'GET') {
        const s = getShare(uid, Number(shareGetMatch[1]));
        if (!s) return sendJson(res, 404, { error: '不存在' });
        return sendJson(res, 200, { ...s, images: listShareImages(Number(shareGetMatch[1])) });
      }
      if (url.startsWith('/api/share') && req.method === 'GET') {
        const dk = new URL(url, 'http://localhost').searchParams.get('doc_key') || undefined;
        return sendJson(res, 200, listShares(uid, dk));
      }
      const shareDelMatch = url.match(/^\/api\/share\/(\d+)$/);
      if (shareDelMatch && req.method === 'DELETE') {
        const id = Number(shareDelMatch[1]);
        if (!getShare(uid, id)) return sendJson(res, 404, { error: '不存在' });
        return sendJson(res, 200, deleteShare(uid, id));
      }

      const mediaListMatch = url.match(/^\/api\/media(?:\?.*)?$/);
      if (mediaListMatch && req.method === 'GET') {
        const u = new URL(url, 'http://localhost');
        const q = u.searchParams.get('q') || undefined;
        const source = u.searchParams.get('source') || undefined;
        return sendJson(res, 200, listMedia(uid, q, source));
      }
      const mediaDelMatch = url.match(/^\/api\/media\/(\d+)$/);
      if (mediaDelMatch && req.method === 'DELETE') {
        const media = getMedia(uid, Number(mediaDelMatch[1]));
        if (!media) return sendJson(res, 404, { error: '不存在' });
        const cfg = requireUserStorage(uid);
        await deleteFromQiniu(cfg, media.qiniu_key);
        deleteMediaRecord(uid, media.id);
        return sendJson(res, 200, { ok: true });
      }

      if (url === '/api/mermaid-cache' && req.method === 'GET') {
        return sendJson(res, 200, getMermaidCache(uid));
      }
      if (url === '/api/mermaid-cache' && req.method === 'POST') {
        const b = await readJson(req);
        putMermaidCache(uid, b.hash, b.key, b.url);
        return sendJson(res, 200, { ok: true });
      }

      return next();
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}
