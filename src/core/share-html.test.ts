import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareHtmlDoc, injectHeadingIds } from './share-html.ts';

test('h2/h3 注入 id 并生成同名 TOC 项', () => {
  const { body, toc } = injectHeadingIds('<h1>A</h1><h2>第二节</h2><h3>细节</h3>');
  assert.match(body, /<h2 id="第二节">第二节<\/h2>/);
  assert.deepEqual(
    toc.map((t) => `${t.level}:${t.id}`),
    ['2:第二节', '3:细节'],
  );
  assert.ok(!toc.some((t) => (t.level as number) === 1), 'h1 不进目录');
});

test('重复标题 slug 编号递增，不产生重复 id', () => {
  const { toc } = injectHeadingIds('<h2>FAQ</h2><h2>FAQ</h2><h2>faq</h2>');
  assert.deepEqual(
    toc.map((t) => t.id),
    ['faq', 'faq-2', 'faq-3'],
  );
});

test('纯符号标题退化为 section，仍有合法 id', () => {
  const { toc } = injectHeadingIds('<h2>---</h2><h2>！！</h2>');
  assert.deepEqual(
    toc.map((t) => t.id),
    ['section', 'section-2'],
  );
});

test('标题里的行内标签只影响文本，不进 id', () => {
  const { body, toc } = injectHeadingIds('<h2>用 <code>npm</code> 装</h2>');
  assert.equal(toc[0]?.text, '用 npm 装');
  assert.match(body, /id="用-npm-装"/);
});

test('归档页自包含：不出现任何外部资源请求，且带暗色与 TOC', () => {
  const html = buildShareHtmlDoc('# 标题\n\n## 小节\n\n正文', '测试文档');
  assert.ok(!/<link\b/i.test(html), '不得引入外部样式表');
  assert.ok(!/<script\b/i.test(html), '不得引入脚本');
  assert.ok(!/src="https?:/i.test(html), '不得引入外部脚本/图片资源');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /class="toc"/);
  assert.match(html, /href="#小节"/);
});

test('无 h2/h3 时不生成空 TOC 容器', () => {
  const html = buildShareHtmlDoc('# 只有一级标题\n\n正文');
  assert.ok(!html.includes('class="toc"'));
});
