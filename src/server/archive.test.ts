import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeDB,
  findDocByArchiveToken,
  getActiveArtifact,
  initDB,
  listArtifacts,
  archiveStatusOf,
  upsertDoc,
} from './db.ts';
import {
  archiveDoc,
  getArchiveStorage,
  imageWarningFor,
  prepareArchiveMarkdown,
  setArchiveStorageForTests,
} from './archive.ts';

function freshProject(): { dir: string; docId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'ptdoc-arch-'));
  process.chdir(dir);
  process.env.PTDOC_ARCHIVE_STORAGE = 'local';
  initDB();
  const r = upsertDoc(1, 'demo/doc', '示例文档', 'demo.md', '# 标题\n\n正文');
  return { dir, docId: r.id };
}

test('prepareArchiveMarkdown：[[链接]] 转明文、图片绝对化、mermaid 生成并上传绝对地址', async () => {
  freshProject();
  process.env.PTDOC_PUBLIC_ORIGIN = 'https://ptdoc.local';
  const storage = getArchiveStorage(1);
  const md = [
    '见 [[目标文档|显示名]] 与 [[纯目标]]。',
    '![外链](http://localhost:1/x.png)',
    '![相对](./img/b.png)',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
  ].join('\n');
  const out = await prepareArchiveMarkdown(1, md, storage);
  assert.ok(out.md.includes('显示名'), '[[a|b]] 应保留显示名');
  assert.ok(out.md.includes('纯目标'));
  assert.ok(!out.md.includes('[['), '不应残留站内链接语法');
  assert.ok(out.md.includes('![相对](https://ptdoc.local/img/b.png)'), '相对图片应绝对化');
  assert.ok(out.md.includes('![外链](http://localhost:1/x.png)'), '绝对链接保持原样');
  assert.ok(out.md.includes('/archive-local/archive-media/mermaid-'), 'mermaid 应换成上传后的地址');
  assert.ok(out.imageWarnings.some((w) => w.includes('localhost:1')), '不可达图片必须列出来而不是静默');
  const svgFile = join(process.cwd(), 'data', 'archive', 'archive-media', out.md.match(/mermaid-([0-9a-f]{16})\.svg/)![0]);
  assert.ok(existsSync(svgFile), 'mermaid SVG 应真实落到存储目录');
  closeDB();
});

test('archiveDoc：首次归档生成 token 与不可变产物文件，重新归档链接不变、版本 +1、旧版 superseded', async () => {
  const { docId } = freshProject();
  delete process.env.PTDOC_PUBLIC_ORIGIN;

  const first = await archiveDoc(1, String(docId));
  assert.equal(first.artifact.version, 1);
  assert.equal(first.unchanged, false);
  assert.ok(first.token.length >= 43, 'token 至少 43 字符');
  assert.match(first.token, /^[A-Za-z0-9_-]+$/);
  const slug = `archive/demo/doc/v1-${first.artifact.source_content_sha256!.slice(0, 8)}`;
  const mdPath = join(process.cwd(), 'data', 'archive', `${slug}.md`);
  const htmlPath = join(process.cwd(), 'data', 'archive', `${slug}.html`);
  assert.ok(existsSync(mdPath) && existsSync(htmlPath), '产物 md/html 应真实落到存储');
  assert.ok(readFileSync(htmlPath, 'utf8').includes('示例文档'), 'html 应含文档标题');
  assert.equal(first.artifact.status, 'active');
  assert.ok(first.artifact.md_size! > 0 && first.artifact.html_size! > 0);

  const second = await archiveDoc(1, String(docId), '再归档一次');
  assert.equal(second.artifact.version, 2);
  assert.equal(second.token, first.token, '链接 token 不轮换（D14）');
  assert.equal(second.unchanged, true, '内容未变应返回 unchanged');
  assert.equal(second.artifact.note, '再归档一次');

  const all = listArtifacts(1, 'demo/doc');
  assert.equal(all.length, 2);
  const active = getActiveArtifact(1, 'demo/doc')!;
  assert.equal(active.version, 2);
  const old = all.find((a) => a.version === 1)!;
  assert.equal(old.status, 'superseded');
  assert.ok(old.superseded_at, '旧版应记录 superseded_at');

  const doc = findDocByArchiveToken(second.token)!;
  assert.equal(doc.doc_key, 'demo/doc');

  // 改一个字 → stale
  upsertDoc(1, 'demo/doc', '示例文档', 'demo.md', '# 标题\n\n正文改了');
  const st = archiveStatusOf(1, 'demo/doc');
  assert.equal(st.stale, true);
  assert.equal(st.version, 2);
  closeDB();
});

test('FR-15 失败注入：上传 html 失败时不产生半成品 shares 行', async () => {
  const { docId } = freshProject();
  const inner = getArchiveStorage(1);
  setArchiveStorageForTests(() => ({
    kind: 'local',
    async put(key, buf, type) {
      if (key.endsWith('.html')) throw new Error('注入的上传失败');
      return inner.put(key, buf, type);
    },
    delete: (key) => inner.delete(key),
  }));
  try {
    await assert.rejects(() => archiveDoc(1, String(docId)), /注入的上传失败/);
    assert.equal(listArtifacts(1, 'demo/doc').length, 0, '失败后不应新增产物行');
  } finally {
    setArchiveStorageForTests(null);
  }
  closeDB();
});

test('getArchiveStorage：未配置存储且非 local 时报 503', () => {
  freshProject();
  delete process.env.PTDOC_ARCHIVE_STORAGE;
  assert.throws(() => getArchiveStorage(1), /对象存储未配置/);
  closeDB();
});

test('FR-26 图片告警区分签名失效(401)与资源不存在(404)', () => {
  const u = 'https://file.example.com/a.png';
  assert.match(imageWarningFor(401, u), /签名失效（HTTP 401）/);
  assert.match(imageWarningFor(403, u), /签名失效（HTTP 403）/, '403 也是签名/权限问题，归到同一类');
  assert.match(imageWarningFor(404, u), /图片不存在（HTTP 404）/);
  assert.match(imageWarningFor(502, u), /图片不可访问（HTTP 502）/, '其他状态码保留原状态，不硬塞进 401/404');
  assert.equal(imageWarningFor(0, u), `图片不可访问：${u}`, '连不上（DNS/超时）保持原文案');
  for (const st of [0, 401, 403, 404, 500]) assert.ok(imageWarningFor(st, u).includes(u), '文案必须带 URL');
});
