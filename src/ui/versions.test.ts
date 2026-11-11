import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDeleteVersion,
  docSegment,
  filterVersions,
  formatSize,
  relativeTime,
  retentionSummary,
  shortSha,
  toMillis,
  validateRetention,
  versionMeta,
  versionTitle,
  versionsUrl,
  versionUrl,
  type VersionItem,
} from './versions.ts';

const v = (over: Partial<VersionItem> = {}): VersionItem => ({
  id: 1,
  kind: 'auto',
  label: null,
  size: 1234,
  sha256_short: 'abc123def456',
  created_at: 1762800000,
  ...over,
});

test('created_at 秒与毫秒都归一：服务端新接口给秒，旧快照是毫秒', () => {
  assert.equal(toMillis(1762800000), 1762800000000);
  assert.equal(toMillis(1762800000000), 1762800000000);
  assert.equal(toMillis(0), 0);
  const now = 1762800000000 + 3 * 60 * 1000;
  assert.equal(relativeTime(1762800000, now), '3 分钟前');
  assert.equal(relativeTime(1762800000000, now), '3 分钟前');
  assert.equal(relativeTime(0), '未知时间');
});

test('相对时间分档与未来时间兜底', () => {
  const now = 1762800000000;
  assert.equal(relativeTime(1762800000 - 10, now), '刚刚');
  assert.equal(relativeTime(1762800000 - 90, now), '1 分钟前');
  assert.equal(relativeTime(1762800000 - 7200, now), '2 小时前');
  assert.equal(relativeTime(1762800000 - 3 * 86400, now), '3 天前');
});

test('大小格式化到 B/KB/MB，整数不带多余小数', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(900), '900 B');
  assert.equal(formatSize(1024), '1 KB');
  assert.equal(formatSize(1280), '1.3 KB');
  assert.equal(formatSize(2.5 * 1024 * 1024), '2.5 MB');
});

test('sha 只取前 7 位十六进制，长短 sha 都适用', () => {
  assert.equal(shortSha('abc123def4567890'), 'abc123d');
  assert.equal(shortSha('abc123d'), 'abc123d');
  assert.equal(shortSha(''), '');
});

test('筛选 全部/自动/手动，且不改原数组', () => {
  const items = [v({ id: 1, kind: 'auto' }), v({ id: 2, kind: 'manual' }), v({ id: 3, kind: 'auto' })];
  assert.deepEqual(filterVersions(items, 'all').map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(filterVersions(items, 'auto').map((x) => x.id), [1, 3]);
  assert.deepEqual(filterVersions(items, 'manual').map((x) => x.id), [2]);
  assert.notEqual(filterVersions(items, 'all'), items);
  assert.equal(items.length, 3);
});

test('只有手动快照可删：自动快照由留存策略淘汰', () => {
  assert.equal(canDeleteVersion('manual'), true);
  assert.equal(canDeleteVersion('auto'), false);
});

test('标题与副标题：空标签按类型兜底，副标题含时间/大小/sha7', () => {
  assert.equal(versionTitle(v({ kind: 'auto' })), '自动快照');
  assert.equal(versionTitle(v({ kind: 'manual' })), '未命名快照');
  assert.equal(versionTitle(v({ label: '  v1 评审稿  ' })), 'v1 评审稿');
  const now = 1762800000000 + 60000;
  assert.equal(versionMeta(v(), now), '1 分钟前 · 1.2 KB · abc123d');
});

test('doc_key 含 / 时按段转义，数字 id 原样', () => {
  assert.equal(docSegment(12), '12');
  assert.equal(docSegment('a/b c'), 'a%2Fb%20c');
});

test('版本接口 URL：列表分页、单条、restore 后缀', () => {
  assert.equal(versionsUrl(12), '/api/docs/12/versions?limit=50');
  assert.equal(versionsUrl(12, 7), '/api/docs/12/versions?limit=50&cursor=7');
  assert.equal(versionsUrl('docs/a.md'), '/api/docs/docs%2Fa.md/versions?limit=50');
  assert.equal(versionUrl(12, 7), '/api/docs/12/versions/7');
  assert.equal(versionUrl(12, 7, '/restore'), '/api/docs/12/versions/7/restore');
});

test('留存策略校验：范围、整数、min ≤ count', () => {
  assert.deepEqual(validateRetention({ snapshot_keep_count: 50, snapshot_keep_days: 30, snapshot_keep_min: 5 }), []);
  assert.deepEqual(validateRetention({ snapshot_keep_count: 0, snapshot_keep_days: 30, snapshot_keep_min: 0 }), [
    '保留条数需为 1-200 的整数',
  ]);
  assert.equal(validateRetention({ snapshot_keep_count: 201, snapshot_keep_days: 30, snapshot_keep_min: 5 }).length, 1);
  assert.equal(validateRetention({ snapshot_keep_count: 50, snapshot_keep_days: 366, snapshot_keep_min: 5 }).length, 1);
  assert.deepEqual(
    validateRetention({ snapshot_keep_count: 3, snapshot_keep_days: 30, snapshot_keep_min: 5 }),
    ['最少保留不能大于保留条数'],
  );
  assert.equal(validateRetention({ snapshot_keep_count: 3.5, snapshot_keep_days: 30, snapshot_keep_min: 1 }).length, 1);
});

test('留存预估文案：有/无待清理', () => {
  assert.equal(retentionSummary(120, 20), '当期 120 条 · 将清理 20 条');
  assert.equal(retentionSummary(8, 0), '当期 8 条 · 不会有快照被清理');
});
