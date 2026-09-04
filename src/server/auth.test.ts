import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { loadServerEnv, resetServerEnvForTests } from './env.ts';
import {
  closeDB,
  initDB,
  countUsers,
  createUser,
  updateUserPassword,
  getUserById,
  deleteSessionsForUser,
} from './db.ts';
import {
  hashPassword,
  verifyPassword,
  validateUsername,
  isLoginLocked,
  recordLoginFailure,
  resetLoginLockForTests,
  issueSession,
  requireUser,
  requireAdmin,
} from './auth.ts';
import { HttpError } from './http.ts';

const GOOD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db');
}

function boot(): void {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: GOOD });
  initDB(tmpDb());
  resetLoginLockForTests();
}

test('密码哈希不可逆且可校验', () => {
  const h = hashPassword('password1');
  assert.match(h, /^scrypt\$/);
  assert.equal(verifyPassword('password1', h), true);
  assert.equal(verifyPassword('password2', h), false);
});

test('用户名规则', () => {
  assert.equal(validateUsername('ab_c'), 'ab_c');
  assert.throws(() => validateUsername('ab'), /3–32/);
});

test('连续 5 次失败后锁定', () => {
  resetLoginLockForTests();
  for (let i = 0; i < 5; i++) recordLoginFailure('alice');
  assert.equal(isLoginLocked('alice'), true);
  assert.equal(isLoginLocked('bob'), false);
});

test('Setup 只允许一次：已有用户时 countUsers > 0', () => {
  boot();
  assert.equal(countUsers(), 0);
  createUser('admin', hashPassword('password1'), 'admin');
  assert.equal(countUsers(), 1);
  closeDB();
});

test('改密后旧 Session 失效', () => {
  boot();
  const user = createUser('alice', hashPassword('password1'), 'member');
  const req = new IncomingMessage(new Socket());
  const chunks: string[] = [];
  const res = new ServerResponse(req);
  res.setHeader = ((_n: string, v: number | string | readonly string[]) => {
    chunks.push(String(v));
    return res;
  }) as typeof res.setHeader;
  const token = issueSession(res, user.id);
  req.headers.cookie = 'ptdoc_session=' + token;
  const u = requireUser(req, res);
  assert.equal(u.id, user.id);
  updateUserPassword(user.id, hashPassword('password2'));
  deleteSessionsForUser(user.id);
  assert.throws(() => requireUser(req, res), (e: unknown) => e instanceof HttpError && e.status === 401);
  closeDB();
});

test('Member 调 requireAdmin 抛 403', () => {
  boot();
  const user = createUser('bob', hashPassword('password1'), 'member');
  assert.throws(() => requireAdmin(user), (e: unknown) => e instanceof HttpError && e.status === 403);
  const admin = createUser('root', hashPassword('password1'), 'admin');
  requireAdmin(admin);
  closeDB();
});

test('getUserById 返回已创建用户', () => {
  boot();
  const u = createUser('carol', hashPassword('password1'), 'member');
  assert.equal(getUserById(u.id)?.username, 'carol');
  closeDB();
});
