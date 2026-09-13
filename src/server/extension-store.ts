import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HttpError } from './http.ts';
import { encryptSecret, decryptSecret } from './storage.ts';
import {
  deleteAgentExtension,
  getAgentExtension,
  getAgentExtensionByName,
  insertAgentExtension,
  listAgentExtensions,
  listEnabledAgentExtensions,
  updateAgentExtension,
  type AgentExtensionRow,
} from './db.ts';
import { extractZipToDir } from './zip-util.ts';

export type ExtensionKind = 'mcp' | 'skill' | 'plugin';

let dataRoot = join(process.cwd(), 'data', 'extensions');
let pluginInstaller: ((dir: string) => void) | null = null;

export function setExtensionsRootForTests(dir: string): void {
  dataRoot = dir;
}

export function setPluginInstallerForTests(fn: ((dir: string) => void) | null): void {
  pluginInstaller = fn;
}

export function extensionsRoot(): string {
  return dataRoot;
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function listRelFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (cur: string) => {
    for (const name of readdirSync(cur)) {
      if (name === 'node_modules') continue;
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

function publicExt(row: AgentExtensionRow, extra?: Record<string, unknown>): Record<string, unknown> {
  let config: unknown = {};
  try {
    config = JSON.parse(row.config_json || '{}');
  } catch {
    config = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: !!row.enabled,
    config,
    secret_configured: !!row.secrets_enc,
    file_dir: row.file_dir,
    files: row.file_dir ? listRelFiles(join(dataRoot, row.file_dir)) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

export function toPublicExtension(row: AgentExtensionRow, extra?: Record<string, unknown>): Record<string, unknown> {
  return publicExt(row, extra);
}

function installPluginDeps(dir: string): void {
  if (!existsSync(join(dir, 'package.json'))) return;
  if (pluginInstaller) {
    pluginInstaller(dir);
    return;
  }
  const r = spawnSync('npm', ['install', '--omit=dev'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120000,
    env: process.env,
  });
  if (r.status !== 0) {
    throw new HttpError(400, (r.stderr || r.stdout || '插件依赖安装失败').slice(0, 300));
  }
}

async function probePlugin(dir: string): Promise<{ tools: number; error?: string }> {
  const entry = existsSync(join(dir, 'index.js'))
    ? join(dir, 'index.js')
    : existsSync(join(dir, 'index.mjs'))
      ? join(dir, 'index.mjs')
      : '';
  if (!entry) return { tools: 0, error: '缺少 index.js 或 index.mjs' };
  try {
    const mod = await import(pathToFileURL(entry).href + '?t=' + Date.now());
    const tools = mod.tools || mod.default?.tools;
    if (!Array.isArray(tools)) return { tools: 0, error: '未导出 tools 数组' };
    return { tools: tools.length };
  } catch (e) {
    return { tools: 0, error: (e as Error).message.slice(0, 200) };
  }
}

function probeSkill(dir: string): { tools: number; error?: string } {
  if (!existsSync(join(dir, 'SKILL.md'))) return { tools: 0, error: '缺少 SKILL.md' };
  return { tools: 1 };
}

export async function probeExtension(row: AgentExtensionRow): Promise<{ tools: number; error?: string }> {
  if (row.kind === 'mcp') {
    const cfg = JSON.parse(row.config_json || '{}') as { transport?: string; command?: string; url?: string };
    if (!cfg.transport) return { tools: 0, error: '缺少 transport' };
    return { tools: 1 };
  }
  if (!row.file_dir) return { tools: 0, error: '缺少文件目录' };
  const dir = join(dataRoot, row.file_dir);
  if (row.kind === 'skill') return probeSkill(dir);
  return probePlugin(dir);
}

export function listExtensions(kind?: string, q?: string): Record<string, unknown>[] {
  return listAgentExtensions(kind, q).map((r) => publicExt(r));
}

export function listEnabledSummaries(): Array<{ name: string; kind: string }> {
  return listEnabledAgentExtensions().map((r) => ({ name: r.name, kind: r.kind }));
}

export function getExtensionOrThrow(id: number): AgentExtensionRow {
  const row = getAgentExtension(id);
  if (!row) throw new HttpError(404, '扩展不存在');
  return row;
}

export async function createMcp(body: any): Promise<Record<string, unknown>> {
  const name = String(body?.name || '').trim();
  const transport = String(body?.transport || '').trim();
  if (!name) throw new HttpError(400, '名称不能为空');
  if (!['http', 'streamable-http', 'sse', 'stdio'].includes(transport)) {
    throw new HttpError(400, 'transport 必须是 http、streamable-http、sse 或 stdio');
  }
  if (getAgentExtensionByName('mcp', name)) throw new HttpError(409, '扩展名称已存在');
  const config: Record<string, unknown> = {
    transport,
    url: body?.url ? String(body.url) : undefined,
    command: body?.command ? String(body.command) : undefined,
    args: Array.isArray(body?.args) ? body.args.map(String) : undefined,
  };
  let secretsEnc: string | null = null;
  if (body?.env || body?.headers) {
    secretsEnc = encryptSecret(JSON.stringify({ env: body.env || undefined, headers: body.headers || undefined }));
  }
  const row = insertAgentExtension({
    kind: 'mcp',
    name,
    config_json: JSON.stringify(config),
    secrets_enc: secretsEnc,
  });
  const probe = await probeExtension(row);
  return publicExt(row, { probe });
}

export async function updateMcp(id: number, body: any): Promise<Record<string, unknown>> {
  const cur = getExtensionOrThrow(id);
  if (cur.kind !== 'mcp') throw new HttpError(400, '类型不匹配');
  const name = body?.name !== undefined ? String(body.name).trim() : cur.name;
  if (!name) throw new HttpError(400, '名称不能为空');
  const transport = String(body?.transport || '').trim();
  if (!['http', 'streamable-http', 'sse', 'stdio'].includes(transport)) {
    throw new HttpError(400, 'transport 必须是 http、streamable-http、sse 或 stdio');
  }
  const dup = getAgentExtensionByName('mcp', name);
  if (dup && dup.id !== id) throw new HttpError(409, '扩展名称已存在');
  const config: Record<string, unknown> = {
    transport,
    url: body?.url ? String(body.url) : undefined,
    command: body?.command ? String(body.command) : undefined,
    args: Array.isArray(body?.args) ? body.args.map(String) : undefined,
  };
  let secretsEnc = cur.secrets_enc;
  if (body?.env || body?.headers) {
    secretsEnc = encryptSecret(JSON.stringify({ env: body.env || undefined, headers: body.headers || undefined }));
  }
  const row = updateAgentExtension(id, { name, config_json: JSON.stringify(config), secrets_enc: secretsEnc });
  const probe = await probeExtension(row);
  return publicExt(row, { probe });
}

async function saveZipKind(
  kind: 'skill' | 'plugin',
  id: number | null,
  name: string,
  zipBuf: Buffer,
): Promise<Record<string, unknown>> {
  if (!name) throw new HttpError(400, '名称不能为空');
  const existing = id ? getExtensionOrThrow(id) : getAgentExtensionByName(kind, name);
  if (!id && existing) throw new HttpError(409, '扩展名称已存在');
  if (id && existing && existing.kind !== kind) throw new HttpError(400, '类型不匹配');
  if (id) {
    const dup = getAgentExtensionByName(kind, name);
    if (dup && dup.id !== id) throw new HttpError(409, '扩展名称已存在');
  }
  const tmpId = id || Date.now();
  const rel = `${kind}s/${tmpId}`;
  const dest = join(dataRoot, rel);
  const backup = dest + '.bak';
  if (existsSync(dest)) {
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    // rename via copy-like: move dest to backup
    rmSync(backup, { recursive: true, force: true });
    try {
      const { renameSync } = await import('node:fs');
      renameSync(dest, backup);
    } catch {
      /* empty */
    }
  }
  ensureDir(dest);
  try {
    extractZipToDir(zipBuf, dest);
    if (kind === 'skill' && !existsSync(join(dest, 'SKILL.md'))) {
      throw new HttpError(400, 'zip 根目录必须包含 SKILL.md');
    }
    if (kind === 'plugin') installPluginDeps(dest);
    let row: AgentExtensionRow;
    if (id) {
      row = updateAgentExtension(id, { name, file_dir: rel, config_json: JSON.stringify({ entry: kind }) });
    } else {
      row = insertAgentExtension({
        kind,
        name,
        config_json: JSON.stringify({ entry: kind }),
        file_dir: rel,
      });
      const finalRel = `${kind}s/${row.id}`;
      if (finalRel !== rel) {
        const finalDest = join(dataRoot, finalRel);
        ensureDir(join(dataRoot, `${kind}s`));
        const { renameSync } = await import('node:fs');
        if (existsSync(finalDest)) rmSync(finalDest, { recursive: true, force: true });
        renameSync(dest, finalDest);
        row = updateAgentExtension(row.id, { file_dir: finalRel });
      }
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    const probe = await probeExtension(row);
    if (probe.error && kind === 'plugin') {
      throw new HttpError(400, probe.error);
    }
    return publicExt(row, { probe });
  } catch (e) {
    if (existsSync(dest) && existsSync(backup)) {
      rmSync(dest, { recursive: true, force: true });
      const { renameSync } = await import('node:fs');
      renameSync(backup, dest);
    }
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}

export async function createSkill(name: string, zipBuf: Buffer): Promise<Record<string, unknown>> {
  return saveZipKind('skill', null, name, zipBuf);
}

export async function updateSkill(id: number, name: string, zipBuf: Buffer): Promise<Record<string, unknown>> {
  return saveZipKind('skill', id, name, zipBuf);
}

export async function createPlugin(name: string, zipBuf: Buffer): Promise<Record<string, unknown>> {
  return saveZipKind('plugin', null, name, zipBuf);
}

export async function updatePlugin(id: number, name: string, zipBuf: Buffer): Promise<Record<string, unknown>> {
  return saveZipKind('plugin', id, name, zipBuf);
}

export function setEnabled(id: number, enabled: boolean): Record<string, unknown> {
  const row = updateAgentExtension(id, { enabled: enabled ? 1 : 0 });
  return publicExt(row);
}

export function removeExtension(id: number): void {
  const row = getExtensionOrThrow(id);
  deleteAgentExtension(id);
  if (row.file_dir) {
    const dir = join(dataRoot, row.file_dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

export function readSkillInstructions(): string {
  const parts: string[] = [];
  for (const row of listEnabledAgentExtensions()) {
    if (row.kind !== 'skill' || !row.file_dir) continue;
    const p = join(dataRoot, row.file_dir, 'SKILL.md');
    if (existsSync(p)) parts.push(readFileSync(p, 'utf8'));
  }
  return parts.join('\n\n');
}

export async function loadPluginTools(): Promise<unknown[]> {
  const tools: unknown[] = [];
  for (const row of listEnabledAgentExtensions()) {
    if (row.kind !== 'plugin' || !row.file_dir) continue;
    const dir = join(dataRoot, row.file_dir);
    const entry = existsSync(join(dir, 'index.js')) ? join(dir, 'index.js') : join(dir, 'index.mjs');
    if (!existsSync(entry)) continue;
    try {
      const mod = await import(pathToFileURL(entry).href + '?t=' + Date.now());
      const list = mod.tools || mod.default?.tools;
      if (Array.isArray(list)) tools.push(...list);
    } catch {
      /* skip broken plugin */
    }
  }
  return tools;
}

export function mcpServerConfigs(): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const row of listEnabledAgentExtensions()) {
    if (row.kind !== 'mcp') continue;
    const cfg = JSON.parse(row.config_json || '{}') as Record<string, unknown>;
    let secrets: { env?: Record<string, string>; headers?: Record<string, string> } = {};
    if (row.secrets_enc) {
      try {
        secrets = JSON.parse(decryptSecret(row.secrets_enc));
      } catch {
        secrets = {};
      }
    }
    const transport = String(cfg.transport || 'stdio');
    if (transport === 'stdio') {
      servers[row.name] = {
        type: 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        env: secrets.env,
        cwd: join(dataRoot, 'mcp-npm'),
      };
    } else {
      servers[row.name] = {
        type: transport === 'streamable-http' ? 'http' : transport,
        url: cfg.url,
        requestInit: secrets.headers ? { headers: secrets.headers } : undefined,
      };
    }
  }
  return servers;
}

export function writeFileForTests(rel: string, content: string): void {
  const full = join(dataRoot, rel);
  ensureDir(join(full, '..'));
  writeFileSync(full, content);
}
