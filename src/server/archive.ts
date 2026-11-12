import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildShareHtmlDoc } from '../core/share-html.ts';
import { inlineCssVars, renderMermaidToSvg } from '../core/mermaid.ts';
import { deleteFromQiniu, resignPrivateUrls, uploadToQiniuWithKey, type QiniuConfig } from './qiniu-uploader.ts';
import { optionalUserStorage, requireUserStorage } from './storage.ts';
import { HttpError } from './http.ts';
import {
  ensureArchivePath,
  ensureDocArchiveToken,
  getActiveArtifact,
  getMermaidCache,
  insertArtifact,
  maxArtifactVersion,
  putMermaidCache,
  resolveDocRef,
  sha256Content,
  type ArtifactRow,
} from './db.ts';

// ─── 存储驱动（FR-15）────────────────────────────────────
// 生产走用户配置的七牛；本机没有密钥时可用 PTDOC_ARCHIVE_STORAGE=local
// 落 ./data/archive（仅 dev/测试，用来把真实链路跑通，而不是只跑 mock）。

export interface ArchiveStorage {
  kind: 'local' | 'qiniu';
  put(key: string, buf: Buffer, contentType: string): Promise<{ url: string; key: string }>;
  delete(key: string): Promise<void>;
}

export function localArchiveRoot(): string {
  return join(process.cwd(), 'data', 'archive');
}

export const LOCAL_ARCHIVE_PREFIX = '/archive-local/';

let storageOverride: ((userId: number) => ArchiveStorage) | null = null;

/** 仅测试用：注入存储实现。 */
export function setArchiveStorageForTests(fn: ((userId: number) => ArchiveStorage) | null): void {
  storageOverride = fn;
}

function localPut(key: string, buf: Buffer): { url: string; key: string } {
  const file = join(localArchiveRoot(), key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  const origin = (process.env.PTDOC_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  return { url: `${origin}${LOCAL_ARCHIVE_PREFIX}${key}`, key };
}

function localDelete(key: string): void {
  const file = join(localArchiveRoot(), key);
  // 防目录穿越
  if (!file.startsWith(localArchiveRoot())) throw new Error('非法对象 key');
  if (existsSync(file)) unlinkSync(file);
}

export function readLocalArchiveObject(key: string): Buffer {
  const file = join(localArchiveRoot(), key);
  if (!file.startsWith(localArchiveRoot())) throw new HttpError(400, '非法对象 key');
  if (!existsSync(file)) throw new HttpError(404, 'Not Found');
  return readFileSync(file);
}

export function getArchiveStorage(userId: number): ArchiveStorage {
  if (storageOverride) return storageOverride(userId);
  if (process.env.PTDOC_ARCHIVE_STORAGE === 'local') {
    return {
      kind: 'local',
      async put(key, buf) {
        return localPut(key, buf);
      },
      async delete(key) {
        localDelete(key);
      },
    };
  }
  let cfg;
  try {
    cfg = requireUserStorage(userId);
  } catch {
    throw new HttpError(503, '对象存储未配置：请先在「设置 → 对象存储」完成配置后再归档');
  }
  return {
    kind: 'qiniu',
    async put(key, buf, contentType) {
      return uploadToQiniuWithKey(cfg, buf, key, contentType);
    },
    async delete(key) {
      await deleteFromQiniu(cfg, key);
    },
  };
}

// ─── 产物内容准备（md 自包含化，FR-15 / D11）─────────────

const MERMAID_FENCE_RE = /^```mermaid[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g;

function safeKeyPath(docKey: string): string {
  return docKey.replace(/[^\w.\-/]/g, '_').replace(/^\/+/, '');
}

function mermaidHash(code: string): string {
  return createHash('sha256').update('v6|' + code.trim()).digest('hex').slice(0, 16);
}

/** 把 ```mermaid 代码块换成已上传的绝对地址图片（复用 mermaid_cache 去重）。 */
async function uploadMermaidBlocks(
  userId: number,
  md: string,
  storage: ArchiveStorage,
): Promise<{ md: string; warnings: string[] }> {
  const blocks = [...md.matchAll(MERMAID_FENCE_RE)];
  if (blocks.length === 0) return { md, warnings: [] };
  const cache = getMermaidCache(userId);
  const warnings: string[] = [];
  let out = '';
  let last = 0;
  for (const m of blocks) {
    const start = m.index ?? 0;
    const code = m[1] ?? '';
    out += md.slice(last, start);
    last = start + m[0].length;
    const hash = mermaidHash(code);
    let url = cache[hash];
    if (!url) {
      try {
        const svg = inlineCssVars(await renderMermaidToSvg(code.trim()));
        const key = `archive-media/mermaid-${hash}.svg`;
        const up = await storage.put(key, Buffer.from(svg, 'utf8'), 'image/svg+xml');
        url = up.url;
        putMermaidCache(userId, hash, up.key, up.url);
      } catch (e) {
        warnings.push(`mermaid 图渲染/上传失败：${(e as Error).message}`);
        out += m[0];
        continue;
      }
    }
    out += `![mermaid](${url})\n`;
  }
  out += md.slice(last);
  return { md: out, warnings };
}

async function headStatus(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return 0;
  }
}

/** HEAD 状态码 → 告警文案：签名失效（401/403）与资源不存在（404）必须区分开，排查方向不同。 */
export function imageWarningFor(status: number, url: string): string {
  if (status === 401 || status === 403) return `图片签名失效（HTTP ${status}）：${url}`;
  if (status === 404) return `图片不存在（HTTP 404）：${url}`;
  if (status === 0) return `图片不可访问：${url}`;
  return `图片不可访问（HTTP ${status}）：${url}`;
}

/**
 * 图片绝对化 + 逐个 HEAD 校验，失败项列出来（不静默）。
 * 私有桶的 URL 在正文里是上传当时签的，归档时多半已过期 → HEAD 前先按当前配置重签一次，
 * 否则稳定误报「签名失效(401)」（输出时还会重签，图其实是好的）。
 */
export async function absolutizeImages(
  md: string,
  publicOrigin: string | undefined,
  privateCfg?: QiniuConfig,
): Promise<{ md: string; warnings: string[] }> {
  const seen = new Map<string, boolean>();
  const warnings: string[] = [];
  const matches = [...md.matchAll(IMAGE_RE)];
  // 公开空间是恒等函数，未配置时直接 HEAD 原文
  const headTarget = (url: string): string => (privateCfg ? resignPrivateUrls(url, privateCfg) : url);
  for (const m of matches) {
    const src = m[2];
    if (!src || src.startsWith('data:')) continue;
    if (seen.has(src)) continue;
    seen.set(src, true);
    if (/^http:\/\//i.test(src) || /^https:\/\//i.test(src)) {
      const st = await headStatus(headTarget(src));
      if (st < 200 || st >= 300) warnings.push(imageWarningFor(st, src));
      continue;
    }
    if (src.startsWith('//')) {
      const abs = 'https:' + src;
      const st = await headStatus(headTarget(abs));
      if (st < 200 || st >= 300) warnings.push(imageWarningFor(st, abs));
      continue;
    }
    if (!publicOrigin) {
      warnings.push(`相对路径图片未绝对化（缺少 PTDOC_PUBLIC_ORIGIN）：${src}`);
    }
  }
  let out = md;
  if (publicOrigin) {
    const base = publicOrigin.replace(/\/$/, '');
    out = md.replace(IMAGE_RE, (full, alt: string, src: string, title: string | undefined) => {
      if (!src || src.startsWith('data:') || /^(https?:)?\/\//i.test(src)) return full;
      return `![${alt}](${base}/${src.replace(/^\.?\//, '')}${title ?? ''})`;
    });
  }
  return { md: out, warnings };
}

export interface PreparedArchive {
  md: string;
  imageWarnings: string[];
}

export async function prepareArchiveMarkdown(
  userId: number,
  content: string,
  storage: ArchiveStorage,
): Promise<PreparedArchive> {
  // [[站内链接]] → 人可读文本（M1 不生成产物间互链）
  const text = content.replace(WIKI_LINK_RE, (_f, target: string, label?: string) => (label ?? target).trim());
  const mermaid = await uploadMermaidBlocks(userId, text, storage);
  const images = await absolutizeImages(
    mermaid.md,
    process.env.PTDOC_PUBLIC_ORIGIN,
    optionalUserStorage(userId),
  );
  return { md: images.md, imageWarnings: [...mermaid.warnings, ...images.warnings] };
}

// ─── 归档动作（FR-15 / FR-16 / FR-20）────────────────────

export interface ArchiveOutcome {
  artifact: ArtifactRow;
  token: string;
  unchanged: boolean;
  imageWarnings: string[];
}

export async function archiveDoc(
  userId: number,
  ref: string,
  note?: string | null,
): Promise<ArchiveOutcome> {
  const doc = resolveDocRef(userId, ref);
  if (!doc) throw new HttpError(404, '文档不存在');
  const storage = getArchiveStorage(userId);
  const prepared = await prepareArchiveMarkdown(userId, doc.content, storage);
  const title = doc.title || doc.doc_key;
  const html = buildShareHtmlDoc(prepared.md, title);
  const sha = sha256Content(doc.content);
  const active = getActiveArtifact(userId, doc.doc_key);
  const version = maxArtifactVersion(userId, doc.doc_key) + 1;
  const base = `archive/${safeKeyPath(doc.doc_key)}/v${version}-${sha.slice(0, 8)}`;
  const mdBuf = Buffer.from(prepared.md, 'utf8');
  const htmlBuf = Buffer.from(html, 'utf8');

  // 先传文件、后落库：上传失败不留半成品行（FR-15 验收）
  // shortcut: 落库失败时已上传的对象会孤立残留在存储里（无引用、不清扫），需要时再加对账任务
  const mdUp = await storage.put(`${base}.md`, mdBuf, 'text/markdown; charset=utf-8');
  const htmlUp = await storage.put(`${base}.html`, htmlBuf, 'text/html; charset=utf-8');
  const token = ensureDocArchiveToken(userId, doc.id);
  const artifact = insertArtifact(userId, doc.doc_key, {
    md: prepared.md,
    mdUrl: mdUp.url,
    htmlUrl: htmlUp.url,
    mdKey: mdUp.key,
    htmlKey: htmlUp.key,
    mdSize: mdBuf.length,
    htmlSize: htmlBuf.length,
    sourceContentSha256: sha,
    note: note ?? null,
  });
  ensureArchivePath(userId, doc.doc_key);
  return {
    artifact,
    token,
    unchanged: active?.source_content_sha256 === sha,
    imageWarnings: prepared.imageWarnings,
  };
}
