import { HttpError } from './http.ts';
import { getQdrantProfile, getShare, listArchive, markQdrantSynced } from './db.ts';
import { decryptSecret } from './storage.ts';
import { upsertArchiveMarkdown } from './qdrant-upsert.ts';

export async function syncArchiveToQdrant(
  userId: number,
  docId: number,
): Promise<{ ok: boolean; chunks: number; qdrant_sync: string; qdrant_synced_at: number | null }> {
  const entry = listArchive(userId).entries.find((e) => e.id === docId);
  if (!entry) throw new HttpError(400, '文档尚未归档');
  const share = getShare(userId, entry.share_id);
  if (!share) throw new HttpError(404, '分享记录不存在');
  const profile = getQdrantProfile(userId);
  if (!profile?.url || !profile.collection) throw new HttpError(400, '请先在设置中配置知识库');
  const apiKey = profile.api_key_enc ? decryptSecret(profile.api_key_enc) : undefined;
  const result = await upsertArchiveMarkdown({
    url: profile.url,
    apiKey,
    collection: profile.collection,
    userId,
    docKey: entry.doc_key,
    title: entry.title,
    archivePath: entry.archive_path,
    mdUrl: entry.md_url,
    htmlUrl: entry.html_url,
    markdown: share.share_md,
  });
  markQdrantSynced(userId, docId, entry.share_id);
  const again = listArchive(userId).entries.find((e) => e.id === docId);
  return {
    ok: true,
    chunks: result.chunks,
    qdrant_sync: again?.qdrant_sync || 'synced',
    qdrant_synced_at: again?.qdrant_synced_at ?? Date.now(),
  };
}
