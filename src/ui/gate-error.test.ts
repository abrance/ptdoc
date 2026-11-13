import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGate } from './gate.ts';

// A2 的回归守卫：门禁自己的两个往返挂掉时，必须挂出一张能重试的卡，
// 而不是静默 return —— 那样 #app 永远 hidden，用户看到的是纯白页，
// 连登录框都没有（比 P0-2 原本「首屏闪一下」更糟）。

interface FakeEl {
  id: string;
  className: string;
  innerHTML: string;
  hidden: boolean;
  inert: boolean;
  textContent: string;
  querySelector(sel: string): null;
  addEventListener(): void;
}

function fakeEl(id: string, hidden = false): FakeEl {
  return {
    id,
    className: '',
    innerHTML: '',
    hidden,
    inert: hidden,
    textContent: '',
    querySelector: () => null,
    addEventListener: () => {},
  };
}

/** 只装 gate.ts 真正用到的那几个 DOM 入口；不引 jsdom，保持零依赖。
 *  innerHTML 赋值时把里面的 id 登记成空壳元素，够 bindForm 挂监听即可。 */
function installDom(): { byId: Map<string, FakeEl>; restore(): void } {
  const byId = new Map<string, FakeEl>();
  const app = fakeEl('app', true);
  byId.set('app', app);
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => {
      const el = fakeEl('');
      registerIdScanner(el, byId);
      return el;
    },
    body: {
      appendChild: (el: FakeEl) => {
        byId.set(el.id, el);
      },
    },
  };
  const prev = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = doc;
  return {
    byId,
    restore: () => {
      (globalThis as { document?: unknown }).document = prev;
    },
  };
}

function registerIdScanner(el: FakeEl, byId: Map<string, FakeEl>): void {
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v: string) => {
      html = v;
      for (const m of v.matchAll(/id="([^"]+)"/g)) {
        if (!byId.has(m[1])) byId.set(m[1], fakeEl(m[1]));
      }
    },
  });
}

function installFetch(impl: (url: string) => Promise<unknown>): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = ((url: string) => impl(String(url))) as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

test('断网（fetch reject）：挂可重试错误卡，#app 仍 hidden，不进 onReady', async () => {
  const dom = installDom();
  const restoreFetch = installFetch(async () => {
    throw new Error('Failed to fetch');
  });
  let ready = 0;
  try {
    await assert.doesNotReject(() => startGate(() => ready++));
    const gate = dom.byId.get('auth-gate');
    assert.ok(gate, '门禁卡片必须被挂上：否则整页白屏');
    assert.equal(gate.hidden, false, '错误卡要看得见');
    assert.match(gate.innerHTML, /gate-retry/, '必须给出重试入口');
    assert.match(gate.innerHTML, /Failed to fetch/, '要把失败原因带给用户，不能只说"出错了"');
    assert.equal(dom.byId.get('app')?.hidden, true, '登录态未知 → 工作区必须保持隐藏');
    assert.equal(ready, 0, '门禁没通过，不许放行工作区');
  } finally {
    restoreFetch();
    dom.restore();
  }
});

test('/api/setup/status 返 500：走同一张错误卡，带上服务端原因', async () => {
  const dom = installDom();
  const restoreFetch = installFetch(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'db down' }),
  }));
  let ready = 0;
  try {
    await assert.doesNotReject(() => startGate(() => ready++));
    const gate = dom.byId.get('auth-gate');
    assert.ok(gate, '500 时同样不能白屏');
    assert.match(gate.innerHTML, /db down/, '服务端给的 error 要透出来');
    assert.equal(dom.byId.get('app')?.hidden, true);
    assert.equal(ready, 0);
  } finally {
    restoreFetch();
    dom.restore();
  }
});

test('正常路径没被兜底逻辑吃掉：已初始化 + 未登录 → 登录卡', async () => {
  const dom = installDom();
  const restoreFetch = installFetch(async (url) =>
    url.includes('/api/setup/status')
      ? { ok: true, status: 200, json: async () => ({ initialized: true }) }
      : { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) },
  );
  let ready = 0;
  try {
    await assert.doesNotReject(() => startGate(() => ready++));
    const gate = dom.byId.get('auth-gate');
    assert.ok(gate);
    assert.match(gate.innerHTML, /auth-form/, '未登录要看到登录表单，而不是错误卡');
    assert.doesNotMatch(gate.innerHTML, /gate-retry/);
    assert.equal(ready, 0, '未登录不许放行');
  } finally {
    restoreFetch();
    dom.restore();
  }
});
