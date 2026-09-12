import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerEnv, resetServerEnvForTests } from './env.ts';
import { closeDB, initDB } from './db.ts';
import { createStoreZip } from './zip-util.ts';
import {
  createMcp,
  createSkill,
  getExtensionOrThrow,
  listExtensions,
  removeExtension,
  setEnabled,
  setExtensionsRootForTests,
  setPluginInstallerForTests,
  updateMcp,
  updateSkill,
  createPlugin,
} from './extension-store.ts';
import { HttpError } from './http.ts';

const GOOD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function boot(): string {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: GOOD });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
  const root = mkdtempSync(join(tmpdir(), 'ext-'));
  setExtensionsRootForTests(root);
  setPluginInstallerForTests(() => {});
  return root;
}

test('Admin 创建 MCP 后可覆盖，重名 409', async () => {
  boot();
  const a = await createMcp({ name: 'exa', transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
  assert.equal(a.name, 'exa');
  await assert.rejects(() => createMcp({ name: 'exa', transport: 'http', url: 'http://x' }), (e: unknown) => {
    return e instanceof HttpError && e.status === 409;
  });
  const b = await updateMcp(a.id as number, { name: 'exa', transport: 'http', url: 'http://new' });
  assert.equal((b.config as { url?: string }).url, 'http://new');
  closeDB();
});

test('Skill zip 覆盖后文件等于新包；缺 SKILL.md 保持旧文件', async () => {
  const root = boot();
  const z1 = createStoreZip({ 'SKILL.md': '# old', 'a.txt': 'a' });
  const created = await createSkill('pack', z1);
  const id = created.id as number;
  const dir = join(root, String(created.file_dir));
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# old');
  const z2 = createStoreZip({ 'SKILL.md': '# new', 'b.txt': 'b' });
  await updateSkill(id, 'pack', z2);
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# new');
  assert.equal(existsSync(join(dir, 'a.txt')), false);
  assert.equal(existsSync(join(dir, 'b.txt')), true);
  const bad = createStoreZip({ 'README.md': 'no skill' });
  await assert.rejects(() => updateSkill(id, 'pack', bad), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# new');
  closeDB();
});

test('删除后 GET 不存在；停用后不在启用列表', async () => {
  boot();
  const a = await createMcp({ name: 'gone', transport: 'http', url: 'http://x' });
  const id = a.id as number;
  setEnabled(id, false);
  assert.equal(getExtensionOrThrow(id).enabled, 0);
  removeExtension(id);
  assert.throws(() => getExtensionOrThrow(id), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(listExtensions().length, 0);
  closeDB();
});

test('Plugin npm install 失败返回 400 且不落新目录', async () => {
  const root = boot();
  setPluginInstallerForTests(() => {
    throw new HttpError(400, 'npm fail');
  });
  const zip = createStoreZip({ 'index.js': 'export const tools = []', 'package.json': '{}' });
  await assert.rejects(() => createPlugin('p1', zip), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.equal(listExtensions().length, 0);
  void root;
  closeDB();
});
