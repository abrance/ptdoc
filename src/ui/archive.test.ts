import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absolute, archiveOpsHtml, qdrantBadgeHtml, type ArchiveItem } from './archive.ts';

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
  qdrant_sync: 'stale',
};

test('归档列表行保留预览与同步知识库入口', () => {
  const html = archiveOpsHtml(item);
  assert.match(html, /data-op="preview"/);
  assert.match(html, /data-op="sync"/);
  assert.match(html, /data-op="open"/);
  assert.match(html, /data-op="copy"/);
  assert.match(html, /data-op="history"/);
});

test('预览链接由同源相对路径补成带 origin 的绝对地址', () => {
  assert.equal(absolute('/a/tok'), 'https://ptdoc.example/a/tok');
  assert.equal(absolute('https://cdn.example/a/tok'), 'https://cdn.example/a/tok');
});

test('知识库徽标三态文案与样式类', () => {
  assert.match(qdrantBadgeHtml('none'), /ar-qdrant-none[^>]*>未同步</);
  assert.match(qdrantBadgeHtml('stale'), /ar-qdrant-stale[^>]*>待同步</);
  assert.match(qdrantBadgeHtml('synced'), /ar-qdrant-synced[^>]*>已同步</);
  assert.match(qdrantBadgeHtml(undefined), /ar-qdrant-none/);
});
