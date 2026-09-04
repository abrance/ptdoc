import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerEnv, resetServerEnvForTests } from './env.ts';
import { closeDB, createUser, getStorageProfile, initDB } from './db.ts';
import { hashPassword } from './auth.ts';
import {
  decryptSecret,
  encryptSecret,
  parseStorageInput,
  requireUserStorage,
  saveVerifiedProfile,
  setConnectivityTesterForTests,
  toPublicProfile,
} from './storage.ts';
import { HttpError } from './http.ts';

const GOOD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function boot(): void {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: GOOD });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
}

test('密钥加解密往返', () => {
  boot();
  const enc = encryptSecret('sk-secret');
  assert.equal(enc.includes('sk-secret'), false);
  assert.equal(decryptSecret(enc), 'sk-secret');
  closeDB();
});

test('公开 Profile 不含 secret_key', () => {
  boot();
  const pub = toPublicProfile(undefined);
  assert.equal('secret_key' in pub, false);
  assert.equal(pub.secret_configured, false);
  closeDB();
});

test('无 Profile 时 requireUserStorage 返回 400', () => {
  boot();
  const u = createUser('alice', hashPassword('password1'), 'member');
  assert.throws(() => requireUserStorage(u.id), (e: unknown) => e instanceof HttpError && e.status === 400);
  closeDB();
});

test('连通性失败不覆盖已验证 Profile', async () => {
  boot();
  const u = createUser('alice', hashPassword('password1'), 'member');
  setConnectivityTesterForTests(async () => {});
  await saveVerifiedProfile(u.id, {
    accessKey: 'ak1',
    secretKey: 'sk1',
    bucket: 'b1',
    domain: 'https://cdn.example.com',
    zone: 'Zone_z0',
    privateBucket: false,
    urlTtl: 3600,
  });
  const first = getStorageProfile(u.id)!;
  setConnectivityTesterForTests(async () => {
    throw new Error('bad key');
  });
  await assert.rejects(
    () =>
      saveVerifiedProfile(u.id, {
        accessKey: 'ak2',
        secretKey: 'sk2',
        bucket: 'b2',
        domain: 'https://cdn2.example.com',
        zone: 'Zone_z0',
        privateBucket: false,
        urlTtl: 3600,
      }),
    (e: unknown) => e instanceof HttpError,
  );
  const after = getStorageProfile(u.id)!;
  assert.equal(after.access_key, first.access_key);
  assert.equal(after.bucket, 'b1');
  setConnectivityTesterForTests(null);
  closeDB();
});

test('parseStorageInput 校验必填字段', () => {
  boot();
  assert.throws(() => parseStorageInput({}), /请填写/);
  closeDB();
});
