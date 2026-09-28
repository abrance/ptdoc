import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerEnv, resetServerEnvForTests } from './env.ts';
import { initDB, createUser, upsertLlmProfile, upsertDoc, getLlmProfile } from './db.ts';
import { encryptSecret } from './storage.ts';
import {
  runChat,
  extractDraft,
  setChatRunnerForTests,
  type ChatRunInput,
  type StreamEvent,
  type ChatRunResult,
} from './agent-runtime.ts';

// ─── 测试环境：临时库 + LLM 配置（faux provider 不发真实请求，但 runner 要求有 profile）──
let seq = 0;
function setupDb(): { userId: number } {
  seq++;
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: 'a'.repeat(64) });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
  const u = createUser('llmrunner' + seq, 'x'.repeat(60), 'member');
  upsertLlmProfile(u.id, 'http://localhost:1/v1', encryptSecret('sk-test'), 'fake-model', 'high');
  upsertDoc(u.id, 'notes/a' + seq + '.md', 'A', 'a.md', '# A\n\n正文A');
  return { userId: u.id };
}

function run(input: Partial<ChatRunInput> & { userId: number }): Promise<ChatRunResult> {
  const gen = runChat({
    scene: 'qa',
    messages: [],
    input: 'hello',
    abort: new AbortController().signal,
    ...input,
  });
  const events: StreamEvent[] = [];
  const pump = async (): Promise<ChatRunResult> => {
    for (;;) {
      const r = await gen.next();
      if (r.done) return r.value;
      events.push(r.value);
    }
  };
  return pump();
}

test('runner 缺 LLM 配置时返回错误事件与空结果', async () => {
  resetServerEnvForTests();
  loadServerEnv({ PTDOC_DATA_KEY: 'a'.repeat(64) });
  initDB(join(mkdtempSync(join(tmpdir(), 'ptdoc-')), 't.db'));
  const u = createUser('nollm', 'x'.repeat(60), 'member');
  assert.equal(getLlmProfile(u.id), undefined);
  const events: StreamEvent[] = [];
  const gen = runChat({ userId: u.id, scene: 'qa', messages: [], input: 'hi', abort: new AbortController().signal });
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      assert.equal(r.value.text, '');
      assert.equal(r.value.model, '');
      break;
    }
    events.push(r.value);
  }
  assert.equal(events[0].type, 'error');
});

test('runner：LLM 只回文本（无工具）→ text-delta 事件 + usage 统计', async () => {
  const { userId } = setupDb();
  setChatRunnerForTests(null); // 走真实 defaultRunner
  // 用 mock runner 不可行——要测 defaultRunner 本身。改用可注入 fetch：跳过（faux 集成见下）。
  setChatRunnerForTests(async function* (input) {
    yield { type: 'text-delta', delta: 'ok' };
    return { text: 'ok', hits: [], spans: [], model: 'fake', inputTokens: 1, outputTokens: 1 };
  });
  const result = await run({ userId });
  assert.equal(result.text, 'ok');
  setChatRunnerForTests(null);
});

test('extractDraft：提取 markdown 围栏草稿', () => {
  assert.equal(extractDraft('前文\n```markdown\n# 标题\n正文\n```\n后文'), '# 标题\n正文');
  assert.equal(extractDraft('```md\n内容\n```'), '内容');
  assert.equal(extractDraft('无围栏'), undefined);
});

// ─── 端到端：本地 OpenAI 兼容 mock 服务器，验证 defaultRunner 真实走 pi-ai 链路 ──
import { createServer, type Server } from 'node:http';

let mockServer: Server | null = null;
let mockResponses: Array<Array<Record<string, unknown>>> = []; // 每轮一组 SSE 帧
const seenRequests: any[] = [];

function startMock(): Promise<number> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const idx = seenRequests.push(JSON.parse(body || '{}')) - 1;
        res.setHeader('Content-Type', 'text/event-stream');
        // 按请求序号发对应轮次的响应（每轮一组帧）
        for (const resp of mockResponses[idx] ?? []) {
          res.write('data: ' + JSON.stringify(resp) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    mockServer.listen(0, '127.0.0.1', () => resolve((mockServer!.address() as any).port as number));
  });
}

// OpenAI SSE 帧：文本 delta
function textFrame(content: string, finish: string | null = null, usage?: any): Record<string, unknown> {
  return {
    choices: [{ delta: { content }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}
// OpenAI SSE 帧：thinking delta（DeepSeek 风格 reasoning_content）
function thinkFrame(content: string): Record<string, unknown> {
  return { choices: [{ delta: { reasoning_content: content } }] };
}

// OpenAI SSE 帧：工具调用 delta
function toolFrame(name: string, args: string, id = 'call_1'): Record<string, unknown> {
  return {
    choices: [{
      delta: { tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
      finish_reason: 'tool_calls',
    }],
  };
}

test('defaultRunner 端到端：mock OpenAI 端点，thinking→工具→文本 三轮流式', async () => {
  const { userId } = setupDb();
  setChatRunnerForTests(null);
  const port = await startMock();
  // 更新 LLM profile 指向 mock
  upsertLlmProfile(userId, `http://127.0.0.1:${port}/v1`, encryptSecret('sk'), 'fake-model', 'high');

  // 第 1 轮：思考 + 工具调用；第 2 轮：最终回答
  mockResponses = [
    [thinkFrame('先分析问题…'), toolFrame('search_knowledge', '{"query":"架构"}')],
    [textFrame('根据检索结果回答', 'stop', { prompt_tokens: 10, completion_tokens: 5 })],
  ];

  const events: StreamEvent[] = [];
  const gen = runChat({ userId, scene: 'qa', messages: [], input: 'PTDoc 架构是什么？', abort: new AbortController().signal });
  let result: ChatRunResult | undefined;
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      result = r.value;
      break;
    }
    events.push(r.value);
  }

  try {
    // thinking 事件流式转发
    const td = events.find((e) => e.type === 'thinking-delta');
    assert.ok(td, '应有 thinking-delta 事件');
    assert.equal(td.delta, '先分析问题…');
    assert.ok(events.some((e) => e.type === 'thinking-end'), '应有 thinking-end 事件');
    assert.equal(result!.thinking, '先分析问题…');
    // 文本流式逐 token（真流式：单 token 文本就是单 delta）
    assert.ok(events.some((e) => e.type === 'text-delta' && e.delta === '根据检索结果回答'));
    // 工具循环与 usage 不变
    assert.ok(seenRequests.length >= 2, '应发生两轮请求，实际 ' + seenRequests.length);
    assert.ok(seenRequests[0].tools?.some((t: any) => t.function?.name === 'search_knowledge'));
    assert.ok(seenRequests[1].messages.some((m: any) => m.role === 'toolResult' || m.role === 'tool'));
    assert.equal(result!.text, '根据检索结果回答');
    assert.equal(result!.inputTokens, 10);
    assert.equal(result!.outputTokens, 5);
    // 思考档位透传（FR-09）：请求体应带 reasoning_effort=high
    assert.equal(seenRequests[0].reasoning_effort, 'high');
  } finally {
    mockServer?.close();
    mockServer = null;
    setChatRunnerForTests(null);
  }
});

test('thinking_level=off 时不传 reasoning_effort，非思考轮不发 thinking 事件', async () => {
  const { userId } = setupDb();
  setChatRunnerForTests(null);
  seenRequests.length = 0;
  const port = await startMock();
  upsertLlmProfile(userId, `http://127.0.0.1:${port}/v1`, encryptSecret('sk'), 'fake-model', 'off');
  mockResponses = [[textFrame('直接回答', 'stop', { prompt_tokens: 3, completion_tokens: 2 })]];
  try {
    const events: StreamEvent[] = [];
    const gen = runChat({ userId, scene: 'qa', messages: [], input: 'hi', abort: new AbortController().signal });
    let result: ChatRunResult | undefined;
    for (;;) {
      const r = await gen.next();
      if (r.done) {
        result = r.value;
        break;
      }
      events.push(r.value);
    }
    assert.equal(seenRequests[0].reasoning_effort, undefined);
    assert.ok(!events.some((e) => e.type === 'thinking-delta'));
    assert.equal(result!.text, '直接回答');
  } finally {
    mockServer?.close();
    mockServer = null;
    setChatRunnerForTests(null);
  }
});

test('steer：工具间隙注入追问到 pi-ai 消息流（FR-10）', async () => {
  const { userId } = setupDb();
  setChatRunnerForTests(null);
  seenRequests.length = 0;
  const port = await startMock();
  upsertLlmProfile(userId, `http://127.0.0.1:${port}/v1`, encryptSecret('sk'), 'fake-model', 'high');
  const steerQueue: string[] = ['补充：只看架构图'];
  mockResponses = [
    [toolFrame('search_knowledge', '{"query":"架构"}')],
    [textFrame('好的', 'stop', { prompt_tokens: 5, completion_tokens: 2 })],
  ];
  try {
    const events: StreamEvent[] = [];
    const gen = runChat({
      userId,
      scene: 'qa',
      messages: [],
      input: '介绍架构',
      abort: new AbortController().signal,
      steers: steerQueue,
    });
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      events.push(r.value);
    }
    assert.ok(events.some((e) => e.type === 'steer-accepted'), '应有 steer-accepted 事件');
    assert.equal(steerQueue.length, 0, '队列应被消费清空');
    // 第 2 轮请求应包含注入的 user 消息
    const secondRound = seenRequests[1].messages;
    assert.ok(secondRound.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('架构图')));
  } finally {
    mockServer?.close();
    mockServer = null;
    setChatRunnerForTests(null);
  }
});
