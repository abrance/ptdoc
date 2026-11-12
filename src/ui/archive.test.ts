import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  absolute,
  archiveOpsHtml,
  mergeArchiveEntries,
  previewUrl,
  qdrantBadgeHtml,
  type ArchiveEntrySync,
  type ArchiveItem,
} from './archive.ts';

// archive.ts 的 absolute() 读 location.origin；Node 测试环境没有 location，这里补一个。
Object.defineProperty(globalThis, 'location', {
  value: { origin: 'https://ptdoc.example' },
  configurable: true,
});

const item: ArchiveItem = {
  doc_id: 7,
  doc_key: 'notes/示例.md',
  title: '示例',
  version: 3,
  created_at: 1_760_000_000,
  stale: false,
  token: 'tok',
  public_url: '/a/tok',
  history_count: 2,
};

test('归档列表行保留预览与同步知识库入口', () => {
  const html = archiveOpsHtml({ ...item, qdrant_sync: 'stale' });
  assert.match(html, /data-op="preview"/);
  assert.match(html, /data-op="sync"/);
  assert.match(html, /data-op="open"[^>]*>编辑原稿</);
  assert.match(html, /data-op="copy"/);
  assert.match(html, /data-op="history"/);
});

test('预览链接由同源相对路径补成带 origin 的绝对地址', () => {
  assert.equal(absolute('/a/tok'), 'https://ptdoc.example/a/tok');
  assert.equal(absolute('https://cdn.example/a/tok'), 'https://cdn.example/a/tok');
});

test('预览永远走 /a/<token>，不碰对象存储 html_url', () => {
  assert.equal(previewUrl({ public_url: '/a/tok' }), 'https://ptdoc.example/a/tok');
  assert.equal(previewUrl({ token: 'tok2' }), 'https://ptdoc.example/a/tok2');
});

test('知识库徽标三态文案与样式类', () => {
  assert.match(qdrantBadgeHtml('none'), /ar-qdrant-none[^>]*>未同步</);
  assert.match(qdrantBadgeHtml('stale'), /ar-qdrant-stale[^>]*>待同步</);
  assert.match(qdrantBadgeHtml('synced'), /ar-qdrant-synced[^>]*>已同步</);
  assert.match(qdrantBadgeHtml(undefined), /ar-qdrant-none[^>]*>未同步</);
});

test('items[] 按 entries[] 补齐 qdrant_sync（doc_key 优先，doc_id 兜底）', () => {
  const entries: ArchiveEntrySync[] = [
    { id: 7, doc_key: 'notes/示例.md', share_id: 31, qdrant_sync: 'synced' },
    { id: 8, doc_key: '其它.md', share_id: 32, qdrant_sync: 'stale' },
  ];
  const merged = mergeArchiveEntries(
    [
      { ...item, doc_key: 'notes/示例.md' },
      { ...item, doc_id: 8, doc_key: '改了名.md', token: 'tok8', public_url: '/a/tok8' },
      { ...item, doc_id: 9, doc_key: '无归档.md' },
    ],
    entries,
  );
  assert.equal(merged[0].qdrant_sync, 'synced');
  assert.equal(merged[1].qdrant_sync, 'stale');
  assert.equal(merged[2].qdrant_sync, undefined);
});

test('items 自身已有 qdrant_sync 时不被 entries 覆盖（后端补齐后的兼容）', () => {
  const merged = mergeArchiveEntries(
    [{ ...item, qdrant_sync: 'none' }],
    [{ id: 7, doc_key: 'notes/示例.md', share_id: 31, qdrant_sync: 'synced' }],
  );
  assert.equal(merged[0].qdrant_sync, 'none');
});

test('接线级：items+entries 渲染出已同步徽标，entries 缺失回落未同步', () => {
  const entries: ArchiveEntrySync[] = [
    { id: 7, doc_key: 'notes/示例.md', share_id: 31, qdrant_sync: 'synced' },
  ];
  const wired = mergeArchiveEntries([{ ...item }], entries);
  assert.match(qdrantBadgeHtml(wired[0].qdrant_sync), /ar-qdrant-synced[^>]*>已同步</);

  const fallback = mergeArchiveEntries([{ ...item }], undefined);
  assert.match(qdrantBadgeHtml(fallback[0].qdrant_sync), /ar-qdrant-none[^>]*>未同步</);
});
