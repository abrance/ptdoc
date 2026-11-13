import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentChrome } from './agent-chrome.ts';

test('空状态：停止 / 补充检索 / 可观测全部不渲染', () => {
  // 这是 P0-3 的形态：新开页面没选会话，结果态的控件却都在，能 Tab 到、点了没反应。
  for (const scene of ['qa', 'writer'] as const) {
    const c = agentChrome(false, scene);
    assert.equal(c.stopHidden, true, `${scene}: 空态不该有「停止」`);
    assert.equal(c.retrieveHidden, true, `${scene}: 空态不该有「补充检索」`);
    assert.equal(c.obsHidden, true, `${scene}: 空态不该有可观测面板`);
  }
});

test('有会话：停止与可观测回来，补充检索仍只在文档编写场景', () => {
  const qa = agentChrome(true, 'qa');
  assert.equal(qa.stopHidden, false);
  assert.equal(qa.obsHidden, false);
  // qa 场景没有"补充检索"这个动作，与空态无关。
  assert.equal(qa.retrieveHidden, true);

  const writer = agentChrome(true, 'writer');
  assert.equal(writer.stopHidden, false);
  assert.equal(writer.obsHidden, false);
  assert.equal(writer.retrieveHidden, false);
});
