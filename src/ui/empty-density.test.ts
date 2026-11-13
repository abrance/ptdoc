import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyStateBlockHtml, emptyStateHtml } from './list-state.ts';

// P1-7：空态一个模板 + 四档密度。以前 media / tree / archive / snapshot
// 各写一份 padding，同一件事在四处看起来像四件事。

test('四档密度各自产出可区分的类名', () => {
  assert.match(emptyStateHtml('x', 'inline'), /class="empty empty-inline"/);
  assert.match(emptyStateHtml('x', 'list'), /class="empty"/);
  assert.doesNotMatch(emptyStateHtml('x', 'list'), /empty-list/, 'list 是默认档，不加后缀');
  assert.match(emptyStateHtml('x', 'panel'), /class="empty empty-panel"/);
  assert.match(emptyStateHtml('x', 'hero'), /class="empty empty-hero"/);
});

test('不传密度时保持 P1-4 的旧类名，历史调用点不会因为新增参数而变样', () => {
  assert.match(emptyStateHtml('暂无记录'), /class="empty"/);
});

test('引导动作插在文案之后，且文案本身先转义', () => {
  const html = emptyStateHtml('<b>A&B</b>', 'hero', '<button class="empty-action">打开文档列表</button>');
  assert.match(html, /&lt;b&gt;A&amp;B&lt;\/b&gt;/, '不可信文案必须转义');
  assert.match(html, /empty-action/);
  assert.ok(html.indexOf('A&amp;B') < html.indexOf('empty-action'), '动作在文案之后');
});

test('div 容器复用同一套密度（网格/树不是 <li>）', () => {
  assert.match(emptyStateBlockHtml('暂无图片', 'panel'), /^<div class="empty empty-panel">/);
});

test('四处调用点都改走模板，不再手写各自的面板类', () => {
  const files = {
    media: readFileSync(new URL('./media.ts', import.meta.url), 'utf8'),
    sidebar: readFileSync(new URL('./sidebar.ts', import.meta.url), 'utf8'),
    archive: readFileSync(new URL('./archive.ts', import.meta.url), 'utf8'),
    versions: readFileSync(new URL('./versions.ts', import.meta.url), 'utf8'),
  };
  assert.doesNotMatch(files.media, /class="media-empty">暂无图片/, '媒体库空态必须走模板');
  assert.doesNotMatch(files.sidebar, /tree-empty">还没有空间/, '侧栏空态必须走模板');
  assert.doesNotMatch(files.archive, /ar-empty">还没有归档产物/, '归档空态必须走模板');
  assert.doesNotMatch(files.versions, /<li class="empty">暂无版本/, '快照面板空态必须走模板');

  assert.match(files.media, /emptyStateBlockHtml\([\s\S]{0,80}'panel'/, '媒体库是整块面板');
  assert.match(files.sidebar, /emptyStateBlockHtml\('没有匹配的文档', 'inline'\)/, '侧栏树是一行');
  assert.match(files.archive, /emptyStateHtml\([\s\S]{0,120}'hero'/, '归档是整页空');
  assert.match(files.versions, /emptyStateHtml\([\s\S]{0,80}'inline'/, '快照面板是一行');
});
