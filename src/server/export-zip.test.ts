import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDB, createUser, initDB, upsertDoc, listAllDocsFull, ensureDocArchiveToken } from './db.ts';
import { buildExportEntries, buildExportZip, docKeyToExportPath } from './export-zip.ts';
import { extractZipToDir } from './zip-util.ts';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'ptdoc-export-')), 't.db');
}

test('docKeyToExportPath 逐段替换非法字符并补 .md（确定性）', () => {
  assert.equal(docKeyToExportPath('notes/a.md'), 'notes/a.md');
  assert.equal(docKeyToExportPath('ops/x:y?.md'), 'ops/x_y_.md');
  assert.equal(docKeyToExportPath('a<b>c|d.md'), 'a_b_c_d.md');
  assert.equal(docKeyToExportPath('docs/../evil.md'), 'docs/_/evil.md'); // .. 段被兜底，不越界
  assert.equal(docKeyToExportPath('noext'), 'noext.md');
  // 同一输入两次调用结果一致
  assert.equal(docKeyToExportPath('x:y?.md'), docKeyToExportPath('x:y?.md'));
});

test('buildExportEntries：子目录路径、同名冲突加 id、INDEX 条目数=文档数、csv 字段', () => {
  const docs = [
    { id: 3, doc_key: 'a.md', title: 'A|表', updated_at: 1000, content: 'A body', archive_token: 'tokA' },
    { id: 7, doc_key: 'a.md', title: 'A2', updated_at: 2000, content: 'A2 body' },
    { id: 9, doc_key: 'dir/sub/b.md', title: 'B', updated_at: 3000, content: 'B body' },
  ];
  const { entries, docCount } = buildExportEntries(docs);
  assert.equal(docCount, 3);
  // 冲突：doc_key 相同的两篇 a.md，第一篇原名，第二篇按 id 加后缀 ~7
  assert.equal(entries['a.md'], 'A body');
  assert.equal(entries['a~7.md'], 'A2 body');
  assert.equal(entries['dir/sub/b.md'], 'B body');

  // INDEX：表头 3 行 + 每篇 1 行
  const index = entries['INDEX.md'];
  const dataRows = index.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !l.includes('标题'));
  assert.equal(dataRows.length, 3, 'INDEX 数据行数应等于文档数');
  // 标题里的竖线被转义，不会撑坏表格
  const aRow = dataRows.find((l) => l.includes('a.md'))!;
  assert.ok(aRow.includes('A 表'), '标题竖线应转成空格');

  // csv：只列有归档链接的，表头 + 1 行
  const csvLines = entries['archive-urls.csv'].trim().split('\n');
  assert.equal(csvLines[0], 'doc_key,archive_url');
  assert.equal(csvLines.length, 2);
  assert.equal(csvLines[1], 'a.md,/a/tokA');
});

test('buildExportZip：解压后每篇 md 与库内 content 字节一致（端到端）', () => {
  initDB(tmpDb());
  const u = createUser('exp', 'x'.repeat(60), 'member');
  const c1 = '# 标题一\n\n正文含 emoji 😀 与换行\n';
  const c2 = 'no heading, 只有正文\n第二行';
  upsertDoc(u.id, 'dir/一.md', '一', '一.md', c1);
  const r2 = upsertDoc(u.id, 'dir/二.md', '二', '二.md', c2);
  ensureDocArchiveToken(u.id, r2.id); // 给一篇加归档 token

  const docs = listAllDocsFull(u.id);
  const zip = buildExportZip(docs);
  const outDir = mkdtempSync(join(tmpdir(), 'ptdoc-unzip-'));
  const files = extractZipToDir(zip, outDir);

  // 每篇文档的 md 都能在解压结果里找到，且字节完全一致
  const contentByKey = new Map(docs.map((d) => [d.doc_key, d.content]));
  const mdFiles = files.filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
  assert.equal(mdFiles.length, docs.length, 'md 文件数应等于文档数');
  for (const d of docs) {
    const path = mdFiles.find((f) => f === d.doc_key)!;
    assert.ok(path, '缺少导出文件: ' + d.doc_key);
    assert.equal(readFileSync(join(outDir, path), 'utf8'), contentByKey.get(d.doc_key));
  }
  // INDEX.md 与 csv 都在包里
  assert.ok(files.includes('INDEX.md'));
  assert.ok(files.includes('archive-urls.csv'));
  closeDB();
});
