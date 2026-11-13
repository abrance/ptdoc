import { test } from 'node:test';
import assert from 'node:assert/strict';

// P0-1 的另一半：失败必须有可点的出路，不能只留一句话。
// node 测试环境没有 DOM，这里给 showToast 一个刚够用的最小假 document。

class FakeEl {
  tagName: string;
  className = '';
  id = '';
  textContent = '';
  type = '';
  children: FakeEl[] = [];
  listeners: Record<string, Array<() => void>> = {};
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ||= []).push(fn);
  }
  setAttribute(): void {}
  classList = {
    add: (c: string) => {
      this.className = (this.className ? this.className + ' ' : '') + c;
    },
  };
  click(): void {
    for (const fn of this.listeners.click ?? []) fn();
  }
  remove(): void {
    removed.push(this);
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.children.filter((c) => sel.split('.').every((s) => s && c.className.split(' ').includes(s)));
  }
}

const removed: FakeEl[] = [];

function installFakeDom(): { body: FakeEl; byId: Map<string, FakeEl> } {
  const byId = new Map<string, FakeEl>();
  const body = new FakeEl('body');
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
    body,
  };
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { setTimeout: () => 0 },
    configurable: true,
  });
  // 上面 body.appendChild 不会自动登记 id；让宿主层能查到 toasts 容器。
  const origAppend = body.appendChild.bind(body);
  body.appendChild = (child: FakeEl) => {
    if (child.id) byId.set(child.id, child);
    return origAppend(child);
  };
  return { body, byId };
}

test('带 action 的提示渲染出可点按钮，点击后执行动作并移除提示', async () => {
  const { byId } = installFakeDom();
  const { showToast } = await import('./toast.ts');

  let retried = 0;
  showToast('归档失败：对象存储上传 阶段：403', 'error', {
    label: '重试',
    onClick: () => {
      retried += 1;
    },
  });

  const host = byId.get('toasts')!;
  assert.equal(host.children.length, 1, '提示应该挂出来');
  const toast = host.children[0];
  assert.match(toast.className, /has-action/, '带按钮的提示要标记出来，便于只留最新一条');

  const btn = toast.children.find((c) => c.tagName === 'button');
  assert.ok(btn, '失败提示必须有一个可点按钮，不能只有文案');
  assert.equal(btn!.textContent, '重试');

  btn!.click();
  assert.equal(retried, 1, '点一下就要真的再跑一遍');
  assert.ok(removed.includes(toast), '点过之后提示自己消失，不留在屏幕上占位');
});

test('不带 action 的普通提示不生成按钮', async () => {
  installFakeDom();
  const { showToast } = await import('./toast.ts');
  showToast('已复制链接', 'success');

  const host = globalThis.document.getElementById('toasts') as unknown as FakeEl;
  const toast = host.children[0];
  assert.equal(toast.children.some((c) => c.tagName === 'button'), false);
});
