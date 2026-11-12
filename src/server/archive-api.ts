import type { Connect } from 'vite';
import {
  archiveStatusOf,
  findDocByArchiveToken,
  getArtifact,
  getArtifactByVersion,
  getDocByKey,
  getActiveArtifact,
  listArchive,
  listArchiveItems,
  listArtifacts,
  markArtifactDeleted,
  resolveDocRef,
  rotateDocArchiveToken,
  ensureDocArchiveToken,
} from './db.ts';
import { archiveDoc, getArchiveStorage, LOCAL_ARCHIVE_PREFIX, readLocalArchiveObject } from './archive.ts';
import { buildShareHtmlDoc } from '../core/share-html.ts';
import { optionalUserStorage } from './storage.ts';
import { resignPrivateUrls } from './qiniu-uploader.ts';
import { requireUser } from './auth.ts';
import { DOC_KEY_PATH_ERROR, HttpError, hasBareDocKeySlash, readJson, sendJson } from './http.ts';
import type { ArtifactRow } from './db.ts';

const CONTENT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function sendHtml(res: any, status: number, html: string, noStore = true): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (noStore) res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function versionUrl(token: string, a: ArtifactRow): string {
  return a.status === 'active' ? `/a/${token}` : `/a/${token}/v/${a.version}`;
}

/** 私有空间下库里的图片链接是上传当时签的，输出前现签一遍（公开空间原样返回）。 */
function freshUrls(userId: number, text: string): string {
  const cfg = optionalUserStorage(userId);
  return cfg ? resignPrivateUrls(text, cfg) : text;
}

function toPublicArtifact(a: ArtifactRow, token: string) {
  return {
    id: a.id,
    version: a.version,
    status: a.status,
    created_at: a.created_at,
    note: a.note,
    md_url: a.md_url,
    html_url: a.html_url,
    md_size: a.md_size,
    html_size: a.html_size,
    source_content_sha256: a.source_content_sha256,
    version_url: versionUrl(token, a),
  };
}

/**
 * 归档相关路由（FR-15 ~ FR-20）。
 * 其中 /a/:token* 为匿名公开入口，其余走登录态；/s/ 的登录墙不动。
 */
export function archiveApiMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = req.url || '';
    const method = req.method || 'GET';
    const isPublic = url.startsWith('/a/') || url.startsWith(LOCAL_ARCHIVE_PREFIX);
    // FR-25：裸斜杠的 doc_key 匹配不到 :id 路由，会静默落进 api.ts 的 GET /api/docs 列表接口
    // 新增 /api/docs/:id/* 子路由必须同步 http.ts 的 DOC_REF_TAILS_RE，否则该路由会被这里 400
    if (hasBareDocKeySlash(url)) return sendJson(res, 400, { error: DOC_KEY_PATH_ERROR });
    const isArchiveApi = /^\/(api\/archive|api\/share\/\d+|api\/docs\/)/.test(url);
    if (!isPublic && !isArchiveApi) return next();
    // 只接管自己负责的路径，其余交回后续中间件
    if (
      isArchiveApi &&
      !/\/archive(-status)?(\/|$|\?)|^\/api\/archive(\?|$)|^\/api\/share\/\d+(\?|$)/.test(url)
    ) {
      return next();
    }

    try {
      // ─── 本机 local 存储的静态回源（仅 dev/测试）───
      if (url.startsWith(LOCAL_ARCHIVE_PREFIX)) {
        if (process.env.PTDOC_ARCHIVE_STORAGE !== 'local') return next();
        if (method !== 'GET' && method !== 'HEAD') return next();
        const key = decodeURIComponent(url.slice(LOCAL_ARCHIVE_PREFIX.length).split('?')[0]);
        const buf = readLocalArchiveObject(key);
        const ext = key.split('.').pop()?.toLowerCase() || '';
        res.statusCode = 200;
        res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.end(method === 'HEAD' ? undefined : buf);
        return;
      }

      // ─── 匿名公开入口 ───
      const versionMatch = url.match(/^\/a\/([A-Za-z0-9_-]+)\/v\/(\d+)(?:\?.*)?$/);
      if (versionMatch && (method === 'GET' || method === 'HEAD')) {
        // 历史产物只对登录用户开放，匿名一律 401
        let user;
        try {
          user = requireUser(req, res);
        } catch {
          return sendJson(res, 401, { error: '未登录' });
        }
        const doc = findDocByArchiveToken(versionMatch[1]);
        if (!doc || doc.user_id !== user.id) return sendJson(res, 404, { error: 'Not Found' });
        const art = getArtifactByVersion(doc.user_id, doc.doc_key, Number(versionMatch[2]));
        if (!art) return sendJson(res, 404, { error: 'Not Found' });
        return sendHtml(res, 200, buildShareHtmlDoc(freshUrls(doc.user_id, art.share_md), doc.title), false);
      }

      const mdMatch = url.match(/^\/a\/([A-Za-z0-9_-]+)\/md(?:\?(.*))?$/);
      if (mdMatch && (method === 'GET' || method === 'HEAD')) {
        const doc = findDocByArchiveToken(mdMatch[1]);
        if (!doc) return sendJson(res, 404, { error: 'Not Found' });
        const art = doc ? getActiveArtifact(doc.user_id, doc.doc_key) : undefined;
        if (!art) return sendJson(res, 410, { error: '该归档已删除' });
        const download = new URLSearchParams(mdMatch[2] || '').get('download') === '1';
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (download) {
          const name = `${doc.doc_key}-v${art.version}.md`.replace(/[^\w.\-]/g, '_');
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        }
        res.end(method === 'HEAD' ? undefined : freshUrls(doc.user_id, art.share_md));
        return;
      }

      const tokenMatch = url.match(/^\/a\/([A-Za-z0-9_-]+)(?:\?.*)?$/);
      if (tokenMatch && (method === 'GET' || method === 'HEAD')) {
        const doc = findDocByArchiveToken(tokenMatch[1]);
        if (!doc) return sendJson(res, 404, { error: 'Not Found' });
        const art = getActiveArtifact(doc.user_id, doc.doc_key);
        if (!art) return sendJson(res, 410, { error: '该归档已删除' });
        return sendHtml(res, 200, buildShareHtmlDoc(freshUrls(doc.user_id, art.share_md), doc.title));
      }

      // ─── 登录态接口 ───
      const user = requireUser(req, res);
      const uid = user.id;

      if (/^\/api\/archive(\?|$)/.test(url) && method === 'GET') {
        const u = new URL(url, 'http://localhost');
        const q = u.searchParams.get('q') || undefined;
        const includeAll = u.searchParams.get('include') === 'all';
        const { items } = listArchiveItems(uid, q, includeAll);
        // 侧边栏归档树仍读 {entries, folders}（归档路径树）；items 供归档产物列表用，两者并存避免两套调用方互踢
        const { entries, folders } = listArchive(uid, q);
        return sendJson(res, 200, {
          items: items.map((i) => ({ ...i, public_url: `/a/${i.token}` })),
          entries,
          folders,
        });
      }

      const rotateMatch = url.match(/^\/api\/docs\/([^/]+)\/archive\/rotate-token$/);
      if (rotateMatch && method === 'POST') {
        const doc = resolveDocRef(uid, rotateMatch[1]);
        if (!doc) throw new HttpError(404, '文档不存在');
        const token = rotateDocArchiveToken(uid, doc.id);
        return sendJson(res, 200, { token, public_url: `/a/${token}` });
      }

      const statusMatch = url.match(/^\/api\/docs\/([^/]+)\/archive-status(?:\?.*)?$/);
      if (statusMatch && method === 'GET') {
        const doc = resolveDocRef(uid, statusMatch[1]);
        if (!doc) throw new HttpError(404, '文档不存在');
        const st = archiveStatusOf(uid, doc.doc_key);
        return sendJson(res, 200, { ...st, public_url: st.token ? `/a/${st.token}` : null });
      }

      const archiveMatch = url.match(/^\/api\/docs\/([^/]+)\/archive(?:\?.*)?$/);
      if (archiveMatch && method === 'POST') {
        const body = await readJson(req).catch(() => ({}) as any);
        const theDoc = resolveDocRef(uid, archiveMatch[1]);
        if (!theDoc) throw new HttpError(404, '文档不存在');
        const out = await archiveDoc(uid, theDoc.doc_key, body?.note ?? null);
        const token = out.token;
        return sendJson(res, 200, {
          id: out.artifact.id,
          version: out.artifact.version,
          token,
          public_url: `/a/${token}`,
          md_url: out.artifact.md_url,
          html_url: out.artifact.html_url,
          unchanged: out.unchanged,
          image_warnings: out.imageWarnings,
        });
      }
      if (archiveMatch && method === 'GET') {
        const doc = resolveDocRef(uid, archiveMatch[1]);
        if (!doc) throw new HttpError(404, '文档不存在');
        const token = ensureDocArchiveToken(uid, doc.id);
        const all = listArtifacts(uid, doc.doc_key);
        const current = all.find((a) => a.status === 'active') ?? null;
        const history = all.filter((a) => a.id !== current?.id);
        const st = archiveStatusOf(uid, doc.doc_key);
        return sendJson(res, 200, {
          token,
          public_url: `/a/${token}`,
          stale: st.stale,
          current: current ? toPublicArtifact(current, token) : null,
          history: history.map((a) => toPublicArtifact(a, token)),
        });
      }

      // DELETE /api/share/:id（?purge=1 彻底删对象）
      const delMatch = url.match(/^\/api\/share\/(\d+)(?:\?(.*))?$/);
      if (delMatch && method === 'DELETE') {
        const id = Number(delMatch[1]);
        const art = getArtifact(uid, id);
        if (!art) throw new HttpError(404, '不存在');
        const purge = new URLSearchParams(delMatch[2] || '').get('purge') === '1';
        let deleted = 0;
        if (purge) {
          const storage = getArchiveStorage(uid);
          for (const key of [art.md_key, art.html_key]) {
            if (!key) continue;
            try {
              await storage.delete(key);
              deleted++;
            } catch (e) {
              throw new HttpError(500, `删除对象失败（${key}）：${(e as Error).message}`);
            }
          }
        }
        markArtifactDeleted(uid, id);
        return sendJson(res, 200, { ok: true, objects_deleted: deleted });
      }

      return next();
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}
