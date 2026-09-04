import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerEnv } from './env.ts';

const GOOD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('缺少 PTDOC_DATA_KEY 时报错', () => {
  assert.throws(() => parseServerEnv({}), /缺少必要环境变量 PTDOC_DATA_KEY/);
});

test('非法 PTDOC_DATA_KEY 时报错', () => {
  assert.throws(() => parseServerEnv({ PTDOC_DATA_KEY: 'abc' }), /64 位十六进制/);
});

test('合法密钥可解析，默认 TTL 7 天', () => {
  const env = parseServerEnv({ PTDOC_DATA_KEY: GOOD });
  assert.equal(env.dataKey.length, 32);
  assert.equal(env.sessionTtlMs, 7 * 24 * 60 * 60 * 1000);
});

test('PTDOC_SESSION_TTL_DAYS 非法时报错', () => {
  assert.throws(() => parseServerEnv({ PTDOC_DATA_KEY: GOOD, PTDOC_SESSION_TTL_DAYS: '0' }), /1 到 365/);
});
