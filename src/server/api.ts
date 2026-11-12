import type { Connect } from 'vite';
import { buildShareHtmlDoc } from '../core/share-html.ts';
import { deleteFromQiniu, resignPrivateUrls } from './qiniu-uploader.ts';
import { optionalUserStorage, requireUserStorage } from './storage.ts';
import { DOC_KEY_PATH_ERROR, HttpError, hasBareDocKeySlash, readJson, sendJson } from './http.ts';
import { requireUser } from './auth.ts';
import {
  initDB,
  upsertDoc,
  getDoc,
  getDocByKey,
  searchDocs,
  listAllDocs,
  listAllDocsFull,
  renameDoc,
  deleteDoc,
  createSnapshot,
  listSnapshots,
  listVersions,
  getVersion,
  getRetention,
  setRetention,
  resolveDocRef,
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
  listArchive,
  updateArchivePath,
  createArchiveFolder,
  renameArchiveFolder,
  deleteArchiveFolder,
  listSpaces,
  createSpace,
  renameSpace,
  deleteSpace,
  reorderSpaces,
  listSpaceTree,
  createSpaceFolder,
  renameSpaceFolder,
  deleteSpaceFolder,
  moveSpaceFolder,
  moveDoc,
  reorderDoc,
} from './db.ts';
import { parseStorageInput, saveVerifiedProfile, selfCheckPrivateBucket, toPublicProfile, verifyConnectivity } from './storage.ts';
import { syncArchiveToQdrant } from './archive-qdrant.ts';

/** 私有空间下库里的图片链接是上传当时签的，输出前现签一遍（公开空间原样返回）。 */
function freshUrls(userId: number, text: string): string {
  const cfg = optionalUserStorage(userId);
  return cfg ? resignPrivateUrls(text, cfg) : text;
}

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
      !url.startsWith('/api/settings') &&
      !url.startsWith('/api/archive') &&
      !url.startsWith('/api/spaces') &&
      !url.startsWith('/api/folders') &&
      !url.startsWith('/s/')
    )
      return next();

    // FR-25：裸斜杠的 doc_key 匹配不到 :id 路由，会静默落进下面的列表接口，必须在入口拒掉
    // 新增 /api/docs/:id/* 子路由必须同步 http.ts 的 DOC_REF_TAILS_RE，否则该路由会被这里 400
    if (hasBareDocKeySlash(url)) return sendJson(res, 400, { error: DOC_KEY_PATH_ERROR });

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
        // 文档已有归档 token → 302 到文档级固定链接（FR-19 兼容）
        const doc = share.doc_key ? getDocByKey(uid, share.doc_key) : undefined;
        if (doc?.archive_token) {
          res.statusCode = 302;
          res.setHeader('Location', `/a/${doc.archive_token}`);
          res.setHeader('Cache-Control', 'no-store');
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(buildShareHtmlDoc(freshUrls(uid, share.share_md)));
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
      // FR-26 自检：上传探针图 → 重签 → HEAD。用请求里的表单值（未保存也能测），不落库
      if (url === '/api/storage/selfcheck' && req.method === 'POST') {
        const b = await readJson(req);
        const cfg = parseStorageInput(b, getStorageProfile(uid));
        return sendJson(res, 200, await selfCheckPrivateBucket(cfg));
      }
      if (url === '/api/storage' && req.method === 'PUT') {
        const b = await readJson(req);
        const cfg = parseStorageInput(b, getStorageProfile(uid));
        const saved = await saveVerifiedProfile(uid, cfg);
        return sendJson(res, 200, saved);
      }

      if (url === '/api/archive/folders' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, createArchiveFolder(uid, b.path));
      }
      if (url === '/api/archive/folders/rename' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, renameArchiveFolder(uid, b.from, b.to));
      }
      const folderDel = url.match(/^\/api\/archive\/folders(?:\?.*)?$/);
      if (folderDel && req.method === 'DELETE') {
        const path = new URL(url, 'http://localhost').searchParams.get('path');
        return sendJson(res, 200, deleteArchiveFolder(uid, path));
      }
      const archivePathMatch = url.match(/^\/api\/docs\/(\d+)\/archive-path$/);
      if (archivePathMatch && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, updateArchivePath(uid, Number(archivePathMatch[1]), b.archive_path));
      }
      const qdrantSyncMatch = url.match(/^\/api\/docs\/(\d+)\/qdrant-sync$/);
      if (qdrantSyncMatch && req.method === 'POST') {
        return sendJson(res, 200, await syncArchiveToQdrant(uid, Number(qdrantSyncMatch[1])));
      }

      // ─── 空间 / 目录 / 拖拽排序 ───
      if (url === '/api/spaces' && req.method === 'GET') {
        return sendJson(res, 200, { spaces: listSpaces(uid) });
      }
      if (url === '/api/spaces' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, createSpace(uid, b.name));
      }
      if (url === '/api/spaces/reorder' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, reorderSpaces(uid, b.order));
      }
      const spaceTreeMatch = url.match(/^\/api\/spaces\/(\d+)\/tree(?:\?.*)?$/);
      if (spaceTreeMatch && req.method === 'GET') {
        return sendJson(res, 200, listSpaceTree(uid, Number(spaceTreeMatch[1])));
      }
      const spaceFolderMatch = url.match(/^\/api\/spaces\/(\d+)\/folders$/);
      if (spaceFolderMatch && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, createSpaceFolder(uid, Number(spaceFolderMatch[1]), b.name, b.parent_id));
      }
      const spaceMatch = url.match(/^\/api\/spaces\/(\d+)(?:\?.*)?$/);
      if (spaceMatch && req.method === 'PATCH') {
        const b = await readJson(req);
        return sendJson(res, 200, renameSpace(uid, Number(spaceMatch[1]), b.name));
      }
      if (spaceMatch && req.method === 'DELETE') {
        const moveTo = new URL(url, 'http://localhost').searchParams.get('move_to');
        return sendJson(res, 200, deleteSpace(uid, Number(spaceMatch[1]), moveTo ?? undefined));
      }
      const folderMoveMatch = url.match(/^\/api\/folders\/(\d+)\/move$/);
      if (folderMoveMatch && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, moveSpaceFolder(uid, Number(folderMoveMatch[1]), b ?? {}));
      }
      const folderMatch = url.match(/^\/api\/folders\/(\d+)$/);
      if (folderMatch && req.method === 'PATCH') {
        const b = await readJson(req);
        return sendJson(res, 200, renameSpaceFolder(uid, Number(folderMatch[1]), b.name));
      }
      if (folderMatch && req.method === 'DELETE') {
        return sendJson(res, 200, deleteSpaceFolder(uid, Number(folderMatch[1])));
      }
      const docMoveMatch = url.match(/^\/api\/docs\/(\d+)\/move$/);
      if (docMoveMatch && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, moveDoc(uid, Number(docMoveMatch[1]), b ?? {}));
      }
      const docReorderMatch = url.match(/^\/api\/docs\/(\d+)\/reorder$/);
      if (docReorderMatch && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, reorderDoc(uid, Number(docReorderMatch[1]), b ?? {}));
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

      // ─── 版本面板（FR-22）: /api/docs/:id/versions*，:id 接受数字 id 或 URL 转义后的 doc_key ───
      const versionRestoreMatch = url.match(/^\/api\/docs\/([^/]+)\/versions\/(\d+)\/restore$/);
      if (versionRestoreMatch && req.method === 'POST') {
        const doc = resolveDocRef(uid, versionRestoreMatch[1]);
        if (!doc) throw new HttpError(404, '文档不存在');
        return sendJson(res, 200, restoreSnapshot(uid, doc.id, Number(versionRestoreMatch[2])));
      }
      const versionOneMatch = url.match(/^\/api\/docs\/([^/]+)\/versions\/(\d+)$/);
      if (versionOneMatch) {
        const doc = resolveDocRef(uid, versionOneMatch[1]);
        if (!doc) throw new HttpError(404, '文档不存在');
        const vid = Number(versionOneMatch[2]);
        if (req.method === 'GET') {
          const v = getVersion(uid, doc.id, vid);
          if (!v) throw new HttpError(404, '版本不存在');
          return sendJson(res, 200, {
            id: v.id,
            kind: v.kind,
            label: v.label,
            content: v.content,
            size: v.size,
            sha256: v.content_sha256,
            created_at: v.created_at,
          });
        }
        if (req.method === 'DELETE') return sendJson(res, 200, deleteSnapshot(uid, vid));
      }
      const versionsMatch = url.match(/^\/api\/docs\/([^/]+)\/versions(?:\?(.*))?$/);
      if (versionsMatch) {
        const doc = resolveDocRef(uid, versionsMatch[1]);
        if (!doc) throw new HttpError(404, '文档不存在');
        if (req.method === 'GET') {
          const q = new URLSearchParams(versionsMatch[2] || '');
          const kind = q.get('kind');
          return sendJson(
            res,
            200,
            listVersions(uid, doc.id, {
              limit: Number(q.get('limit') || 50),
              cursor: q.get('cursor') ? Number(q.get('cursor')) : undefined,
              kind: kind === 'auto' || kind === 'manual' ? kind : undefined,
            }),
          );
        }
        if (req.method === 'POST') {
          const b = await readJson(req).catch(() => ({}) as any);
          return sendJson(res, 200, createSnapshot(uid, doc.id, b?.label));
        }
      }

      // ─── 留存策略（FR-23）─────────────────────────────────
      if (/^\/api\/settings\/retention(?:\?.*)?$/.test(url)) {
        if (req.method === 'GET') return sendJson(res, 200, getRetention(uid));
        if (req.method === 'PUT') {
          const b = await readJson(req);
          if (b == null || typeof b !== 'object') throw new HttpError(400, '请求体不是对象');
          return sendJson(res, 200, setRetention(uid, b));
        }
      }

      if (url === '/api/docs' && req.method === 'POST') {
        const b = await readJson(req);
        const r = upsertDoc(uid, b.doc_key, b.title ?? '', b.filename ?? '', b.content ?? '', {
          spaceId: b.space_id ?? undefined,
          folderId: b.folder_id ?? undefined,
        });
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
        // 已由 archiveApiMiddleware 接管（含 ?purge=1 彻底删除）
        return next();
      }

      const mediaListMatch = url.match(/^\/api\/media(?:\?.*)?$/);
      if (mediaListMatch && req.method === 'GET') {
        const u = new URL(url, 'http://localhost');
        const q = u.searchParams.get('q') || undefined;
        const source = u.searchParams.get('source') || undefined;
        const rows = listMedia(uid, q, source);
        const cfg = optionalUserStorage(uid);
        if (cfg?.privateBucket) {
          for (const r of rows) r.url = resignPrivateUrls(r.url, cfg);
        }
        return sendJson(res, 200, rows);
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
