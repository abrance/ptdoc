// 媒体库从「右侧抽屉」改为「归档 Tab 下的主区域子页」：
// 这里守住三件事，防止有人改回抽屉或让插入功能再次不可达。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const mediaTs = readFileSync(new URL('./media.ts', import.meta.url), 'utf8');
const appTs = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('媒体库是归档页的主区域子页，不是抽屉', () => {
  assert.match(html, /data-archive-view="media"/, 'index.html 应有媒体库子页');
  assert.match(html, /class="archive-page media-page"/, '媒体库页沿用 archive-page 布局');
  assert.doesNotMatch(mediaTs, /classList\.add\('drawer'\)|className = 'drawer/, 'media.ts 不应再创建抽屉');
  assert.doesNotMatch(mediaTs, /document\.body\.appendChild/, 'media.ts 不应再往 body 挂浮层');
});

test('归档 Sider 有两项导航，且媒体库不再是 page-head 里的按钮', () => {
  assert.match(html, /id="archive-nav"[\s\S]{0,200}data-archive-view="artifacts"/, 'Sider 需要归档产物项');
  assert.match(html, /id="archive-nav"[\s\S]{0,300}data-archive-view="media"/, 'Sider 需要媒体库项');
  assert.doesNotMatch(html, /<button id="media"/, '页头那个媒体库按钮应已删除');
  assert.doesNotMatch(html, /share-media-btn/, '旧的 share-media-btn 入口应已删除');
});

test('子页切换：进入归档 Tab 复位到「归档产物」，点媒体库才拉数据', () => {
  assert.match(appTs, /data-archive-view/, 'app.ts 要接管子页切换');
  assert.match(
    appTs,
    /p\.classList\.contains\('archive-page'\)\) p\.hidden = !on/,
    '主区域子页用 hidden 切换（[hidden] 有 display:none!important 兜底）',
  );
  assert.match(appTs, /if \(view === 'media'\) void mediaPanel\.refresh\(\)/, '切到媒体库时才刷新');
});

test('插入图片后自动渲染并保存，且状态栏说明去了哪里', () => {
  assert.match(
    appTs,
    /onInsert:[\s\S]{0,240}scheduleRender\(\);[\s\S]{0,80}scheduleSave\(\);/,
    '插入后必须 render + save（媒体库在归档页，编辑器不在视野里）',
  );
  assert.match(appTs, /已插入到文档光标处/, '要给用户可见的反馈');
});

test('网格是卡片式自适应列，空态走模板', () => {
  assert.match(css, /\.media-grid \{[\s\S]{0,200}grid-template-columns: repeat\(auto-fill, minmax\(150px, 1fr\)\)/, '卡片网格');
  assert.match(css, /\.media-item \{[\s\S]{0,160}flex-direction: column/, '卡片纵向排布');
  assert.match(mediaTs, /emptyStateBlockHtml\([\s\S]{0,160}'panel'/, '空态走统一模板');
});
