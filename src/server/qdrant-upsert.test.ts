import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerEnv, resetServerEnvForTests } from './env.ts';
import {
  closeDB,
  createUser,
  initDB,
  insertShare,
  listArchive,
  markQdrantSynced,
  upsertDoc,
  upsertQdrantProfile,
} from './db.ts';
import { encryptSecret } from './storage.ts';
import { buildPoints, chunkMarkdown, pointId, setQdrantUpsertForTests, upsertArchiveMarkdown } from './qdrant-upsert.ts';
import { syncArchiveToQdrant } from './archive-qdrant.ts';

const GOOD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('chunkMarkdown 短文保持单段，长文按空行切开', () => {
  assert.deepEqual(chunkMarkdown('hello'), ['hello']);
  const a = 'a'.repeat(800);
  const b = 'b'.repeat(800);
  const chunks = chunkMarkdown(a + '\n\n' + b, 1200);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], a);
  assert.equal(chunks[1], b);
});

test('pointId 对同一文档同一段稳定', () => {
  assert.equal(pointId(1, 'a.md', 0), pointId(1, 'a.md', 0));
  assert.notEqual(pointId(1, 'a.md', 0), pointId(1, 'a.md', 1));
});

test('buildPoints 写入 title/path/text payload', () => {
  const points = buildPoints(
    {
      url: 'http://q',
      collection: 'c',
      userId: 3,
      docKey: 'notes.md',
      title: 'Notes',
      archivePath: 'proj/notes.md',
      mdUrl: 'https://qiniu/x.md',
      htmlUrl: 'https://qiniu/x.html',
      markdown: 'hello',
    },
    ['hello'],
  );
  assert.equal(points.length, 1);
  assert.equal(points[0].text, 'hello');
  assert.equal(points[0].payload.title, 'Notes');
  assert.equal(points[0].payload.path, 'proj/notes.md');
  assert.equal(points[0].payload.doc_key, 'notes.md');
});

test('upsertArchiveMarkdown 走注入 client，空文不写点', async () => {
  const seen: unknown[] = [];
  setQdrantUpsertForTests(async (opts) => {
    seen.push(opts.points);
  });
  const r = await upsertArchiveMarkdown({
    url: 'http://q',
    collection: 'c',
    userId: 1,
    docKey: 'a.md',
    title: 'A',
    archivePath: 'a.md',
    mdUrl: null,
    htmlUrl: 'https://x',
    markdown: '   ',
  });
  assert.equal(r.chunks, 0);
  assert.deepEqual(seen, [[]]);
  setQdrantUpsertForTests(null);
});

test('同步成功后 listArchive.qdrant_sync 为 synced，新分享后变 stale', async () => {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: GOOD });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
  const u = createUser('alice', 'hash', 'member');
  const d = upsertDoc(u.id, 'a.md', 'A', 'a.md', '# a');
  insertShare(u.id, 'a.md', '# a', [], undefined, 'https://qiniu.example/a.html');
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'none');
  upsertQdrantProfile(u.id, 'http://q', encryptSecret('k'), 'col', null, 5);
  setQdrantUpsertForTests(async () => {});
  const r = await syncArchiveToQdrant(u.id, d.id);
  assert.equal(r.qdrant_sync, 'synced');
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'synced');
  insertShare(u.id, 'a.md', '# a2', [], undefined, 'https://qiniu.example/a2.html');
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'stale');
  markQdrantSynced(u.id, d.id, listArchive(u.id).entries[0].share_id);
  assert.equal(listArchive(u.id).entries[0].qdrant_sync, 'synced');
  setQdrantUpsertForTests(null);
  closeDB();
});
