import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 回归守卫：`hidden` 属性必须真的藏住元素。
//
// 事故来源：UA 样式里 [hidden]{display:none} 只是普通声明，被任何带
// `display:flex/grid/block` 的类选择器盖掉。ptdoc 里 `.agent-draft, .agent-input
// { display: flex }`、`.archive-result { display: flex }`、`.admin-ext
// { display: flex }` 都属于这一类 —— hidden=true 的元素照样渲染、照样进 Tab 序列，
// 空会话页的「停止」「写入当前文档」能被 Tab 撞进去，点了什么也不发生。
//
// 浏览器实测（本机 dev server，main f4915e4）：修复前空态第 21 次 Tab 落在
// #agent-stop 上，第 16~18 次落在 #draft-current / #draft-new / #draft-cancel 上。
// 唯一可靠的兜底是 CSS 里显式的 [hidden]{display:none !important}。

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('[hidden] 有全局 !important 兜底，能压过 .agent-draft{display:flex} 这类规则', () => {
  // 逐条规则检查：选择器只含 [hidden] 的那条必须带 !important。
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim(),
    body: m[2],
  }));
  const hiddenRules = rules.filter((r) => /\[hidden\]/.test(r.sel) && /(^|,)\s*\[hidden\]\s*$/.test(r.sel));
  const strong = hiddenRules.filter((r) => /display\s*:\s*none\s*!important/.test(r.body));

  assert.ok(
    strong.length > 0,
    'styles.css 缺少全局 [hidden]{display:none !important}：UA 的 display:none 会被类选择器盖掉，' +
      `隐藏元素仍会进 Tab 序列（实测空态第 21 次 Tab 落在 #agent-stop）。现有 [hidden] 规则：${JSON.stringify(hiddenRules)}`,
  );
});
