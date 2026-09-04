import type { Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  claimOrphanRecords,
  countUsers,
  createUser,
  deleteSession,
  deleteSessionsForUser,
  getUserByUsername,
  initDB,
  listUsers,
  updateUserPassword,
  updateUserRole,
  updateUserStatus,
  type UserRole,
} from './db';
import {
  clearLoginFailures,
  hashPassword,
  hashToken,
  isLoginLocked,
  issueSession,
  readSessionToken,
  recordLoginFailure,
  requireAdmin,
  requireUser,
  toPublicUser,
  validatePassword,
  validateUsername,
  verifyPassword,
} from './auth';
import { HttpError, clearSessionCookie, readJson, sendJson } from './http';

function publicPath(url: string, method: string): boolean {
  if (url.startsWith('/api/setup') && (method === 'GET' || method === 'POST')) return true;
  if (url === '/api/auth/register' && method === 'POST') return true;
  if (url === '/api/auth/login' && method === 'POST') return true;
  return false;
}

export function authApiMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/setup') && !url.startsWith('/api/auth') && !url.startsWith('/api/admin')) {
      return next();
    }
    try {
      initDB();
      if (url === '/api/setup/status' && req.method === 'GET') {
        return sendJson(res, 200, { initialized: countUsers() > 0 });
      }
      if (url === '/api/setup' && req.method === 'POST') {
        return handleSetup(req, res);
      }
      if (url === '/api/auth/register' && req.method === 'POST') {
        return handleRegister(req, res);
      }
      if (url === '/api/auth/login' && req.method === 'POST') {
        return handleLogin(req, res);
      }
      if (url === '/api/auth/logout' && req.method === 'POST') {
        return handleLogout(req, res);
      }
      if (url === '/api/auth/me' && req.method === 'GET') {
        const user = requireUser(req, res);
        return sendJson(res, 200, toPublicUser(user));
      }
      if (url === '/api/auth/password' && req.method === 'POST') {
        return handleChangePassword(req, res);
      }
      if (url === '/api/admin/users' && req.method === 'GET') {
        const user = requireUser(req, res);
        requireAdmin(user);
        return sendJson(res, 200, listUsers());
      }
      const roleMatch = url.match(/^\/api\/admin\/users\/(\d+)\/role$/);
      if (roleMatch && req.method === 'POST') {
        const admin = requireUser(req, res);
        requireAdmin(admin);
        const b = await readJson(req);
        const role = b.role as UserRole;
        if (role !== 'admin' && role !== 'member') throw new HttpError(400, '无效角色');
        const id = Number(roleMatch[1]);
        if (id === admin.id && role !== 'admin') throw new HttpError(400, '不能取消自己的管理员角色');
        updateUserRole(id, role);
        return sendJson(res, 200, { ok: true });
      }
      const statusMatch = url.match(/^\/api\/admin\/users\/(\d+)\/status$/);
      if (statusMatch && req.method === 'POST') {
        const admin = requireUser(req, res);
        requireAdmin(admin);
        const b = await readJson(req);
        const status = b.status as 'active' | 'disabled';
        if (status !== 'active' && status !== 'disabled') throw new HttpError(400, '无效状态');
        const id = Number(statusMatch[1]);
        if (id === admin.id) throw new HttpError(400, '不能停用自己的账号');
        updateUserStatus(id, status);
        if (status === 'disabled') deleteSessionsForUser(id);
        return sendJson(res, 200, { ok: true });
      }
      const resetMatch = url.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
      if (resetMatch && req.method === 'POST') {
        const admin = requireUser(req, res);
        requireAdmin(admin);
        const b = await readJson(req);
        const password = validatePassword(String(b.password || ''));
        const id = Number(resetMatch[1]);
        updateUserPassword(id, hashPassword(password));
        deleteSessionsForUser(id);
        return sendJson(res, 200, { ok: true });
      }
      if (!publicPath(url, req.method || '')) {
        requireUser(req, res);
      }
      return next();
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}

async function handleSetup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (countUsers() > 0) throw new HttpError(409, '系统已初始化');
  const b = await readJson(req);
  const username = validateUsername(String(b.username || ''));
  const password = validatePassword(String(b.password || ''));
  const user = createUser(username, hashPassword(password), 'admin');
  claimOrphanRecords(user.id);
  issueSession(res, user.id);
  sendJson(res, 200, toPublicUser(user));
}

async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (countUsers() === 0) throw new HttpError(400, '请先完成系统初始化');
  const b = await readJson(req);
  const username = validateUsername(String(b.username || ''));
  const password = validatePassword(String(b.password || ''));
  if (getUserByUsername(username)) throw new HttpError(409, '用户名已被使用');
  const user = createUser(username, hashPassword(password), 'member');
  issueSession(res, user.id);
  sendJson(res, 200, toPublicUser(user));
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (isLoginLocked(username)) throw new HttpError(429, '登录失败次数过多，请 15 分钟后再试');
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(username);
    throw new HttpError(401, '用户名或密码错误');
  }
  if (user.status === 'disabled') throw new HttpError(403, '账号已停用');
  clearLoginFailures(username);
  issueSession(res, user.id);
  sendJson(res, 200, toPublicUser(user));
}

function handleLogout(req: IncomingMessage, res: ServerResponse): void {
  const token = readSessionToken(req);
  if (token) deleteSession(hashToken(token));
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleChangePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = requireUser(req, res);
  const b = await readJson(req);
  if (!verifyPassword(String(b.old_password || ''), user.password_hash)) {
    throw new HttpError(401, '原密码错误');
  }
  const next = validatePassword(String(b.new_password || ''));
  updateUserPassword(user.id, hashPassword(next));
  deleteSessionsForUser(user.id);
  issueSession(res, user.id);
  sendJson(res, 200, { ok: true });
}
