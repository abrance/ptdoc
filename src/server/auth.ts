import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServerEnv } from './env.ts';
import { HttpError, parseCookies, SESSION_COOKIE, setSessionCookie } from './http.ts';
import {
  deleteSession,
  getUserByApiTokenHash,
  getSessionUser,
  insertSession,
  touchSession,
  type UserRow,
  type UserRole,
} from './db.ts';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const API_TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const loginFails = new Map<string, { count: number; until: number }>();

export function validateUsername(username: string): string {
  const u = username.trim();
  if (!USERNAME_RE.test(u)) {
    throw new HttpError(400, '用户名为 3–32 位字母、数字、点、下划线或连字符');
  }
  return u;
}

export function validatePassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    throw new HttpError(400, '密码长度为 8–72 个字符');
  }
  return password;
}

export function validateApiToken(raw: string): string {
  const t = raw.trim();
  if (!API_TOKEN_RE.test(t)) {
    throw new HttpError(400, 'API Token 为 16–64 位字母或数字');
  }
  return t;
}

export function parseBearer(authorization: string): string {
  const m = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) throw new HttpError(401, '未登录');
  return m[1];
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (!salt.length || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueSession(res: ServerResponse, userId: number): string {
  const token = randomBytes(32).toString('hex');
  const ttl = getServerEnv().sessionTtlMs;
  const expiresAt = Date.now() + ttl;
  insertSession(hashToken(token), userId, expiresAt);
  setSessionCookie(res, token, Math.floor(ttl / 1000));
  return token;
}

export function readSessionToken(req: IncomingMessage): string {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

export function requireUser(req: IncomingMessage, res: ServerResponse): UserRow {
  const authz = req.headers.authorization;
  if (authz !== undefined) {
    const raw = Array.isArray(authz) ? authz[0] || '' : authz;
    const token = parseBearer(raw);
    const user = getUserByApiTokenHash(hashToken(token));
    if (!user) throw new HttpError(401, '未登录');
    if (user.status === 'disabled') throw new HttpError(403, '账号已停用');
    return user;
  }
  const token = readSessionToken(req);
  if (!token) throw new HttpError(401, '未登录');
  const user = getSessionUser(hashToken(token));
  if (!user) throw new HttpError(401, '未登录');
  if (user.status === 'disabled') throw new HttpError(403, '账号已停用');
  const ttl = getServerEnv().sessionTtlMs;
  touchSession(hashToken(token), Date.now() + ttl);
  setSessionCookie(res, token, Math.floor(ttl / 1000));
  return user;
}

export function requireAdmin(user: UserRow): void {
  if (user.role !== 'admin') throw new HttpError(403, '权限不足');
}

export function isLoginLocked(username: string): boolean {
  const row = loginFails.get(username.toLowerCase());
  if (!row) return false;
  if (row.until && Date.now() < row.until) return true;
  if (row.until && Date.now() >= row.until) {
    loginFails.delete(username.toLowerCase());
    return false;
  }
  return false;
}

export function recordLoginFailure(username: string): void {
  const key = username.toLowerCase();
  const prev = loginFails.get(key) || { count: 0, until: 0 };
  const count = prev.count + 1;
  loginFails.set(key, {
    count,
    until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0,
  });
}

export function clearLoginFailures(username: string): void {
  loginFails.delete(username.toLowerCase());
}

export function resetLoginLockForTests(): void {
  loginFails.clear();
}

export function toPublicUser(user: UserRow): {
  id: number;
  username: string;
  role: UserRole;
  status: UserRow['status'];
  created_at: number;
  has_api_token: boolean;
} {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
    has_api_token: !!user.api_token_hash,
  };
}

export { deleteSession };
