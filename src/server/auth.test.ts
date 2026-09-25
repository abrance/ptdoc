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
  setUserApiTokenHash,
  updateUserStatus,
} from './db.ts';
import {
  hashPassword,
  verifyPassword,
  validateUsername,
  validateApiToken,
  parseBearer,
  hashToken,
  toPublicUser,
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

const TOKEN_A = 'Abcdefghijklmnop';
const TOKEN_B = 'AbcdefghijklmnopQ';

function mockPair(): { req: IncomingMessage; res: ServerResponse; cookies: string[] } {
  const req = new IncomingMessage(new Socket());
  const cookies: string[] = [];
  const res = new ServerResponse(req);
  res.setHeader = ((_n: string, v: number | string | readonly string[]) => {
    cookies.push(String(v));
    return res;
  }) as typeof res.setHeader;
  return { req, res, cookies };
}

test('validateApiToken 拒绝非法格式', () => {
  assert.throws(() => validateApiToken('abcdefghijklmno'), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.throws(() => validateApiToken('abcdefghijklmnop!'), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.throws(() => validateApiToken(''), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.equal(validateApiToken(TOKEN_A), TOKEN_A);
});

test('parseBearer 只接受 Bearer 方案', () => {
  assert.equal(parseBearer('Bearer ' + TOKEN_A), TOKEN_A);
  assert.equal(parseBearer('bearer ' + TOKEN_A), TOKEN_A);
  assert.throws(() => parseBearer('Token ' + TOKEN_A), (e: unknown) => e instanceof HttpError && e.status === 401);
  assert.throws(() => parseBearer(''), (e: unknown) => e instanceof HttpError && e.status === 401);
});

test('Bearer 鉴权成功且不写 Session Cookie', () => {
  boot();
  const user = createUser('alice', hashPassword('password1'), 'member');
  setUserApiTokenHash(user.id, hashToken(TOKEN_A));
  const { req, res, cookies } = mockPair();
  req.headers.authorization = 'Bearer ' + TOKEN_A;
  const u = requireUser(req, res);
  assert.equal(u.id, user.id);
  assert.equal(cookies.some((c) => c.includes('ptdoc_session=')), false);
  closeDB();
});

test('错误 Token 或未配置时 Authorization 返回 401', () => {
  boot();
  const user = createUser('alice', hashPassword('password1'), 'member');
  const { req, res } = mockPair();
  req.headers.authorization = 'Bearer ' + TOKEN_A;
  assert.throws(() => requireUser(req, res), (e: unknown) => e instanceof HttpError && e.status === 401);
  setUserApiTokenHash(user.id, hashToken(TOKEN_A));
  req.headers.authorization = 'Bearer ' + TOKEN_B;
  assert.throws(() => requireUser(req, res), (e: unknown) => e instanceof HttpError && e.status === 401);
  closeDB();
});

test('Cookie 与 Bearer 同时出现时以 Bearer 为准', () => {
  boot();
  const alice = createUser('alice', hashPassword('password1'), 'member');
  const bob = createUser('bob', hashPassword('password1'), 'member');
  setUserApiTokenHash(bob.id, hashToken(TOKEN_A));
  const { req, res } = mockPair();
  const token = issueSession(res, alice.id);
  req.headers.cookie = 'ptdoc_session=' + token;
  req.headers.authorization = 'Bearer ' + TOKEN_A;
  const u = requireUser(req, res);
  assert.equal(u.id, bob.id);
  closeDB();
});

test('存在 Authorization 头时不回退 Cookie', () => {
  boot();
  const user = createUser('alice', hashPassword('password1'), 'member');
  const { req, res } = mockPair();
  const token = issueSession(res, user.id);
  req.headers.cookie = 'ptdoc_session=' + token;
  req.headers.authorization = '';
  assert.throws(() => requireUser(req, res), (e: unknown) => e instanceof HttpError && e.status === 401);
  closeDB();
});

test('轮换后旧 Token 失效，清空后 Bearer 401 且 Cookie 可用', () => {
  boot();
  const user = createUser('alice', hashPassword('password1'), 'member');
  setUserApiTokenHash(user.id, hashToken(TOKEN_A));
  setUserApiTokenHash(user.id, hashToken(TOKEN_B));
  const { req, res } = mockPair();
  req.headers.authorization = 'Bearer ' + TOKEN_A;
  assert.throws(() => requireUser(req, res), (e: unknown) => e instanceof HttpError && e.status === 401);
  req.headers.authorization = 'Bearer ' + TOKEN_B;
  assert.equal(requireUser(req, res).id, user.id);
  setUserApiTokenHash(user.id, null);
  assert.throws(() => requireUser(req, res), (e: unknown) => e instanceof HttpError && e.status === 401);
  delete req.headers.authorization;
  const cookie = issueSession(res, user.id);
  req.headers.cookie = 'ptdoc_session=' + cookie;
  assert.equal(requireUser(req, res).id, user.id);
  closeDB();
});

test('两用户提交相同 API Token 时后者 409', () => {
  boot();
  const a = createUser('alice', hashPassword('password1'), 'member');
  const b = createUser('bob', hashPassword('password1'), 'member');
  setUserApiTokenHash(a.id, hashToken(TOKEN_A));
  assert.throws(
    () => setUserApiTokenHash(b.id, hashToken(TOKEN_A)),
    (e: unknown) => e instanceof HttpError && e.status === 409,
  );
  closeDB();
});

test('停用后 Bearer 403；改密后 Bearer 仍成功', () => {
  boot();
  const user = createUser('alice', hashPassword('password1'), 'member');
  setUserApiTokenHash(user.id, hashToken(TOKEN_A));
  const { req, res } = mockPair();
  req.headers.authorization = 'Bearer ' + TOKEN_A;
  updateUserPassword(user.id, hashPassword('password2'));
  deleteSessionsForUser(user.id);
  assert.equal(requireUser(req, res).id, user.id);
  updateUserStatus(user.id, 'disabled');
  assert.throws(() => requireUser(req, res), (e: unknown) => e instanceof HttpError && e.status === 403);
  closeDB();
});

test('toPublicUser 报告 has_api_token 且不含哈希', () => {
  boot();
  const user = createUser('alice', hashPassword('password1'), 'member');
  assert.equal(toPublicUser(user).has_api_token, false);
  setUserApiTokenHash(user.id, hashToken(TOKEN_A));
  const fresh = getUserById(user.id)!;
  const pub = toPublicUser(fresh);
  assert.equal(pub.has_api_token, true);
  assert.equal('api_token_hash' in pub, false);
  closeDB();
});
