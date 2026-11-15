import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Type,
  createModels,
  createProvider,
  type Context,
  type Message,
  type Model,
  type Tool as PiTool,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { decryptSecret } from './storage.ts';
import { getDoc, getLlmProfile, getQdrantProfile, listAllDocs, searchDocs } from './db.ts';
import { retrieveHits, type RetrievedHit } from './qdrant-retriever.ts';
import { loadPluginTools, mcpServerConfigs, readSkillInstructions } from './extension-store.ts';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

export interface StreamEvent {
  type: string;
  delta?: string;
  data?: unknown;
  errorText?: string;
  [k: string]: unknown;
}

export interface ChatRunInput {
  userId: number;
  scene: 'qa' | 'writer';
  messages: ChatMessage[];
  input: string;
  docId?: number;
  abort: AbortSignal;
  /** steer：工具间隙注入的追问（FR-10，agent-api 在流式期间填充） */
  steers?: string[];
}

export interface ChatRunResult {
  text: string;
  draft?: string;
  hits: RetrievedHit[];
  spans: Array<{ name: string; ms: number; ok: boolean; detail?: string }>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinking?: string;
  /** 流式过程中发生的错误（未中断循环时随结果返回，供 API 层标记失败 turn） */
  errorText?: string;
  /** FR-33：本轮 qa 走了全文检索兜底（未配置向量库）时为 true，API 层据此在回答前加提示 */
  retrievalFallback?: boolean;
}

export type ChatRunner = (input: ChatRunInput) => AsyncGenerator<StreamEvent, ChatRunResult>;

let runner: ChatRunner | null = null;

export function setChatRunnerForTests(fn: ChatRunner | null): void {
  runner = fn;
}

export function newTraceId(): string {
  return randomBytes(12).toString('hex');
}

export function extractDraft(text: string): string | undefined {
  const m = text.match(/```(?:markdown|md)?\n([\s\S]*?)```/i);
  return m ? m[1].trim() : undefined;
}

function qaInstructions(skills: string, fullTextFallback = false): string {
  return [
    '你是 PTDoc 知识库问答助手。先用 search_knowledge 检索用户工作区文档后再回答；必要时用 list_workspace_docs / read_workspace_doc 直接读全文。',
    '引用检索片段，不要编造来源。未命中时明确说明。',
    '回答正文中在引用检索片段处标注角标 [1] [2]（编号对应检索返回顺序），便于溯源。',
    fullTextFallback
      ? '未配置向量库，已用本地全文检索（结果偏保守）；不要提及向量库/embedding 等技术细节。'
      : '',
    '需要多角度并行检索时，可用 subagent_spawn 派发子任务（上限 3），完成后 subagent_wait_all 汇总结果再回答。',
    skills,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function writerInstructions(skills: string, currentDoc?: string): string {
  return [
    '你是 PTDoc Markdown 编写助手。只输出可写回的 Markdown。完整草稿放在 markdown 代码围栏中。',
    '使用 list_workspace_docs / read_workspace_doc 阅读工作区；不要声称已写入磁盘。',
    '需要多角度并行调研时，可用 subagent_spawn 派发子任务（上限 3），完成后 subagent_wait_all 汇总结果。',
    currentDoc ? '当前打开文档：\n' + currentDoc.slice(0, 20000) : '',
    skills,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function executeTool(
  userId: number,
  scene: 'qa' | 'writer',
  name: string,
  args: Record<string, unknown>,
  hits: RetrievedHit[],
  spans: ChatRunResult['spans'],
): Promise<string> {
  const t0 = Date.now();
  try {
    if (name === 'search_knowledge') {
      const query = String(args.query || '');
      const profile = getQdrantProfile(userId);
      // FR-33：未配置 Qdrant 时退化为本地全文检索（searchDocs），不再直接报错
      if (!profile) {
        const local = searchDocsToHits(userId, query);
        hits.push(...local);
        spans.push({ name, ms: Date.now() - t0, ok: true, detail: 'fallback:' + local.length });
        return JSON.stringify(local);
      }
      const apiKey = profile.api_key_enc ? decryptSecret(profile.api_key_enc) : undefined;
      let found: RetrievedHit[] = [];
      try {
        found = await retrieveHits(
          {
            url: profile.url,
            apiKey,
            collection: profile.collection,
            vectorName: profile.vector_name || undefined,
            topK: profile.top_k,
          },
          query,
        );
      } catch (e) {
        // Qdrant 配了但不可用：不硬失败，退回全文检索，保证仍能回答
        const local = searchDocsToHits(userId, query);
        hits.push(...local);
        spans.push({ name, ms: Date.now() - t0, ok: true, detail: 'qdrant-error-fallback:' + local.length });
        return JSON.stringify(local);
      }
      // 两路合并去重：向量结果在前，全文命中里补充向量没覆盖到的文档
      const merged = mergeHits(found, searchDocsToHits(userId, query));
      hits.push(...merged);
      spans.push({ name, ms: Date.now() - t0, ok: true, detail: String(merged.length) });
      return JSON.stringify(merged);
    }
    if (name === 'list_workspace_docs') {
      const docs = listAllDocs(userId).map((d) => ({ doc_key: d.doc_key, title: d.title, id: d.id }));
      spans.push({ name, ms: Date.now() - t0, ok: true });
      return JSON.stringify(docs);
    }
    if (name === 'read_workspace_doc') {
      // 既接受数字 doc_id，也接受 doc_key（模型从 list_workspace_docs 里拿到的常是 key）
      const ref = args.doc_id;
      let doc: ReturnType<typeof getDoc> = undefined;
      if (typeof ref === 'number' && Number.isFinite(ref)) doc = getDoc(userId, ref);
      else if (typeof ref === 'string' && ref.trim()) {
        const s = ref.trim();
        doc = /^\d+$/.test(s) ? getDoc(userId, Number(s)) : undefined;
        if (!doc) {
          const all = listAllDocs(userId);
          const hit = all.find((d) => d.doc_key === s || d.filename === s);
          if (hit) doc = getDoc(userId, hit.id);
        }
      }
      spans.push({ name, ms: Date.now() - t0, ok: !!doc });
      if (!doc) return '文档不存在';
      return JSON.stringify({ doc_key: doc.doc_key, title: doc.title, content: doc.content });
    }
    spans.push({ name, ms: Date.now() - t0, ok: false, detail: 'unknown tool' });
    return '未知工具';
  } catch (e) {
    spans.push({ name, ms: Date.now() - t0, ok: false, detail: (e as Error).message });
    return (e as Error).message;
  }
}

/** FR-33：本地全文检索结果 → RetrievedHit（与 Qdrant 结果同形，供统一引用角标）。 */
function searchDocsToHits(userId: number, query: string, limit = 8): RetrievedHit[] {
  const q = query.trim();
  if (!q) return [];
  return searchDocs(userId, q, limit).map((d) => ({
    id: String(d.id),
    title: d.title || d.doc_key,
    snippet: buildSnippet(userId, d.id, q),
    score: 0,
    source: d.doc_key,
    doc_key: d.doc_key,
  }));
}

/** 从片段命中的关键词附近截一段做摘要（searchDocs 只回列表，不带 content）。 */
function buildSnippet(userId: number, docId: number, q: string, span = 120): string {
  const doc = getDoc(userId, docId);
  if (!doc) return '';
  const i = doc.content.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return doc.content.slice(0, span).trim();
  const start = Math.max(0, i - span / 2);
  return doc.content.slice(start, start + span).trim();
}

/**
 * 合并两路检索结果去重。
 * - 向量 chunks 全部保留（同一篇文档的多 chunk 合法）；
 * - 本地整篇命中若 doc_key 已出现在向量结果里，则剔除（向量已覆盖该篇）；
 * - 两边都没有 doc_key 时回退按 id 去重，避免重复引用。
 */
function mergeHits(a: RetrievedHit[], b: RetrievedHit[]): RetrievedHit[] {
  const seenIds = new Set<string>();
  const vecDocKeys = new Set<string>();
  const out: RetrievedHit[] = [];
  for (const h of a) {
    const idKey = 'id:' + h.id;
    if (seenIds.has(idKey)) continue;
    seenIds.add(idKey);
    if (h.doc_key) vecDocKeys.add(h.doc_key);
    out.push(h);
  }
  for (const h of b) {
    if (h.doc_key && vecDocKeys.has(h.doc_key)) continue; // 向量已覆盖整篇，剔除本地整篇命中
    if (seenIds.has('id:' + h.id)) continue; // 无 doc_key 或真实重复时按 id 兜底
    seenIds.add('id:' + h.id);
    out.push(h);
  }
  return out;
}

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** 只读工作区工具（writer 与 qa 共用，FR-33 起 qa 也注册） */
function workspaceReadTools(): PiTool[] {
  return [
    {
      name: 'list_workspace_docs',
      description: '列出当前用户工作区文档',
      parameters: Type.Object({}),
    },
    {
      name: 'read_workspace_doc',
      description: '读取一篇工作区文档全文（doc_id 传文档 id 或 doc_key 均可）',
      parameters: Type.Object({ doc_id: Type.String({ description: '文档 id 或 doc_key' }) }),
    },
  ];
}

/** 场景工具定义（TypeBox schema，由 pi-ai 转换成各 provider 的 wire 格式） */
function sceneTools(scene: 'qa' | 'writer'): PiTool[] {
  if (scene === 'qa') {
    return [
      {
        name: 'search_knowledge',
        description: '检索用户工作区文档片段（配了 Qdrant 走向量，未配走本地全文检索）',
        parameters: Type.Object({ query: Type.String({ description: '检索查询词' }) }),
      },
      ...workspaceReadTools(),
    ];
  }
  return workspaceReadTools();
}

/** 子代理工具 = 场景只读工具（需求 FR-13：无 subagent_*，无写权限） */
function subagentTools(scene: 'qa' | 'writer'): PiTool[] {
  return sceneTools(scene).filter((t) => t.name !== 'subagent_spawn' && t.name !== 'subagent_wait_all');
}

/** 用户 LLM 设置 → pi-ai OpenAI 兼容 provider（每次运行重建，读库解密最新配置） */
function buildModels(userId: number): {
  models: ReturnType<typeof createModels>;
  model: Model<'openai-completions'>;
  thinkingLevel: ThinkingLevel;
} | null {
  const llm = getLlmProfile(userId);
  if (!llm) return null;
  const apiKey = decryptSecret(llm.api_key_enc);
  const model: Model<'openai-completions'> = {
    id: llm.model,
    name: llm.model,
    api: 'openai-completions',
    provider: 'ptdoc-llm',
    baseUrl: joinUrl(llm.base_url, ''),
    // reasoning 开启后 pi-ai 才接受 thinking 档位；具体端点不支持时传参被静默忽略
    reasoning: llm.thinking_level !== 'off',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  };
  const provider = createProvider({
    id: 'ptdoc-llm',
    name: 'PTDoc LLM',
    baseUrl: joinUrl(llm.base_url, ''),
    auth: {
      apiKey: {
        name: 'PTDoc 大模型 API Key',
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model, thinkingLevel: (llm.thinking_level || 'high') as ThinkingLevel };
}

function joinUrl(base: string, _path: string): string {
  const b = base.replace(/\/$/, '');
  return b.endsWith('/v1') ? b : b + '/v1';
}

/** 外部历史消息 → pi-ai 消息。
 *  注意：AssistantMessage.content 必须是 block 数组（pi-ai transformMessages 会调 content.flatMap），
 *  传纯字符串会在第二轮起抛 "content.flatMap is not a function"。历史回复转成单 text block，
 *  并补齐 provider/api/stopReason 等必需字段（isSameModel 判断用，历史非同源则 thinking 块降级为纯文本——这里本来就只有 text）。 */
function toPiMessages(input: ChatRunInput): Message[] {
  const out: Message[] = [];
  for (const m of input.messages) {
    if (m.role === 'system') continue; // system 由 systemPrompt 承载
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text: m.content }],
        api: 'openai-completions',
        provider: 'ptdoc-llm',
        model: 'history',
        stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        timestamp: Date.now(),
      } as unknown as Message);
    } else {
      out.push({ role: 'user', content: m.content, timestamp: Date.now() } as Message);
    }
  }
  out.push({ role: 'user', content: input.input, timestamp: Date.now() } as Message);
  return out;
}

interface ToolLoopOpts {
  userId: number;
  scene: 'qa' | 'writer';
  context: Context;
  models: ReturnType<typeof createModels>;
  model: Model<'openai-completions'>;
  streamOpts: { signal: AbortSignal; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  hits: RetrievedHit[];
  spans: ChatRunResult['spans'];
  /** 主循环回调：转发 text/thinking 增量与工具事件（子代理传 undefined：静默跑） */
  onEvent?: (ev: StreamEvent) => void | Promise<void>;
  maxRounds: number;
}

/**
 * 通用工具循环（FR-08 流式 + 工具轮）。主会话与子代理共用：
 * 子代理传自己的 context（工具面已收窄）、onEvent=undefined（静默）。
 * 返回最终文本与 thinking。错误向上抛（AbortError 原样）。
 */
async function runToolLoop(opts: ToolLoopOpts): Promise<{ text: string; thinking: string }> {
  const { userId, scene, context, models, model, streamOpts, hits, spans, onEvent, maxRounds } = opts;
  let text = '';
  let thinking = '';
  for (let round = 0; round < maxRounds; round++) {
    if (streamOpts.signal.aborted) break;
    let assistant;
    let roundText = '';
    try {
      const stream = models.stream(model, context, streamOpts);
      for await (const ev of stream) {
        if (ev.type === 'text_delta') {
          roundText += ev.delta;
          text += ev.delta;
          await onEvent?.({ type: 'text-delta', delta: ev.delta });
        } else if (ev.type === 'thinking_delta') {
          await onEvent?.({ type: 'thinking-delta', delta: ev.delta });
        } else if (ev.type === 'thinking_end') {
          await onEvent?.({ type: 'thinking-end' });
        }
      }
      assistant = await stream.result();
    } catch (e) {
      if ((e as Error).name === 'AbortError' || streamOpts.signal.aborted) break;
      throw e;
    }
    // pi-ai 对上游失败不抛异常：result() 正常 resolve（stopReason='error' + errorMessage）
    if (assistant.stopReason === 'error') {
      throw new Error(assistant.errorMessage || '大模型请求失败');
    }
    // 防丢帧：以最终 message 为准校正文本（缺尾部则补发增量）
    const fullText = assistant.content
      .filter((c): c is (typeof assistant.content)[number] & { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    if (fullText && !roundText.endsWith(fullText)) {
      const missed = fullText.startsWith(roundText) ? fullText.slice(roundText.length) : fullText;
      if (missed) {
        text += missed;
        await onEvent?.({ type: 'text-delta', delta: missed });
      }
    }
    for (const part of assistant.content) {
      if (part.type === 'thinking') thinking += part.thinking;
    }
    if (thinking) await onEvent?.({ type: 'thinking-end' });
    const calls = assistant.content.filter((c): c is ToolCall => c.type === 'toolCall');
    if (!calls.length) break;
    context.messages.push(assistant);
    for (const call of calls) {
      await onEvent?.({ type: 'tool-call', toolName: call.name });
      let args: Record<string, unknown> = {};
      try {
        args = (call.arguments || {}) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const out = await executeTool(userId, scene, call.name, args, hits, spans);
      await onEvent?.({ type: 'tool-result', toolName: call.name, result: out.slice(0, 2000) });
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: out }],
        isError: false,
        timestamp: Date.now(),
      } as Message);
    }
  }
  return { text, thinking };
}

async function* defaultRunner(input: ChatRunInput): AsyncGenerator<StreamEvent, ChatRunResult> {
  const built = buildModels(input.userId);
  if (!built) {
    yield { type: 'error', errorText: '请先在设置中填写大模型 Base URL、API Key 与模型名' };
    return { text: '', hits: [], spans: [], model: '', inputTokens: 0, outputTokens: 0 };
  }
  const { models, model, thinkingLevel } = built;
  const skills = readSkillInstructions();
  // FR-33：qa 场景没配向量库 → search_knowledge 走本地全文检索兜底，回答后要带提示
  const retrievalFallback = input.scene === 'qa' && !getQdrantProfile(input.userId);
  let currentDoc = '';
  if (input.docId) {
    const d = getDoc(input.userId, input.docId);
    if (d) currentDoc = `# ${d.title}\n\n${d.content}`;
  }
  const context: Context = {
    systemPrompt:
      input.scene === 'qa' ? qaInstructions(skills, retrievalFallback) : writerInstructions(skills, currentDoc),
    messages: toPiMessages(input),
    tools: [
      ...sceneTools(input.scene),
      {
        name: 'subagent_spawn',
        description: '派发一个子代理并行处理子任务。子代理只有只读工具（检索/读文档），无嵌套派发。任务描述要自包含。',
        parameters: Type.Object({ task: Type.String({ description: '自包含的子任务描述' }) }),
      },
      {
        name: 'subagent_wait_all',
        description: '阻塞等待全部子代理完成，返回各自结果摘要（含失败原因）。汇总前必须调用。',
        parameters: Type.Object({}),
      },
    ],
  };
  const hits: RetrievedHit[] = [];
  const spans: ChatRunResult['spans'] = [];
  let thinking = '';
  let inputTokens = 0;
  let outputTokens = 0;
  // 子代理状态（FR-13）：上限 3 并发，主 turn 结束统一回收
  interface Sub {
    id: string;
    task: string;
    status: 'running' | 'done';
    result?: string;
    error?: string;
    ac: AbortController;
    settle: Promise<void>;
  }
  const subagents = new Map<string, Sub>();
  /** 已发过 subagent-update 的子代理（每个只通知一次） */
  const subNotified = new Set<string>();
  let subagentIdSeq = 0;

  const streamOpts = { signal: input.abort, reasoningEffort: thinkingLevel === 'off' ? undefined : thinkingLevel };

  const spawnSubagent = (task: string): Sub => {
    subagentIdSeq++;
    const id = `sa_${subagentIdSeq}`;
    const ac = new AbortController();
    // 主 abort → 级联取消子代理
    const onAbort = () => ac.abort();
    input.abort.addEventListener('abort', onAbort, { once: true });
    const sub: Sub = { id, task, status: 'running', ac, settle: null as unknown as Promise<void> };
    subagents.set(id, sub);
    sub.settle = (async () => {
      const t0 = Date.now();
      const spanId = `subagent:${id}`;
      try {
        const subContext: Context = {
          systemPrompt:
            input.scene === 'qa'
              ? '你是 PTDoc 子代理，专注完成分配的子任务后简要汇报结论。' + (input.scene === 'qa' ? '引用检索结果，不编造。' : '')
              : '你是 PTDoc 子代理，专注完成分配的子任务后简要汇报结论。',
          messages: [{ role: 'user', content: task, timestamp: Date.now() } as Message],
          tools: subagentTools(input.scene),
        };
        const r = await runToolLoop({
          userId: input.userId,
          scene: input.scene,
          context: subContext,
          models,
          model,
          streamOpts: { signal: ac.signal, ...{ reasoningEffort: streamOpts.reasoningEffort } },
          hits,
          spans,
          maxRounds: 4,
        });
        sub.result = r.text.slice(0, 8000) || '（无输出）';
        sub.status = 'done';
        spans.push({ name: spanId, ms: Date.now() - t0, ok: true, detail: task.slice(0, 60) });
      } catch (e) {
        sub.error = ((e as Error).message || '子代理失败').slice(0, 200);
        sub.status = 'done';
        spans.push({ name: spanId, ms: Date.now() - t0, ok: false, detail: sub.error });
      } finally {
        input.abort.removeEventListener('abort', onAbort);
      }
    })();
    return sub;
  };

  const waitAll = async (): Promise<string> => {
    await Promise.all(Array.from(subagents.values()).map((s) => s.settle));
    return JSON.stringify(
      Array.from(subagents.values()).map(({ id, task, status, result, error }) => ({ id, task, status, result, error })),
    );
  };

  let lastError: string | null = null;
  let text = '';
  for (let round = 0; round < 6; round++) {
    if (input.abort.aborted) break;
    // steer：本轮请求发出前，把排队中的追问注入为 user 消息（FR-10 工具间隙）
    const steers = input.steers?.splice(0);
    for (const s of steers || []) {
      context.messages.push({ role: 'user', content: s, timestamp: Date.now() } as Message);
      yield { type: 'steer-accepted', data: { text: s } };
    }
    let assistant;
    let roundText = '';
    try {
      // 真流式：逐事件转发 text/thinking delta（FR-07/08）
      const stream = models.stream(model, context, streamOpts);
      for await (const ev of stream) {
        if (ev.type === 'text_delta') {
          roundText += ev.delta;
          text += ev.delta;
          yield { type: 'text-delta', delta: ev.delta };
        } else if (ev.type === 'thinking_delta') {
          yield { type: 'thinking-delta', delta: ev.delta };
        } else if (ev.type === 'thinking_end') {
          yield { type: 'thinking-end' };
        }
      }
      assistant = await stream.result();
    } catch (e) {
      if ((e as Error).name === 'AbortError' || streamOpts.signal.aborted) break;
      lastError = ((e as Error).message || '大模型请求失败').slice(0, 200);
      yield { type: 'error', errorText: lastError };
      return { text, thinking, hits, spans, model: model.id, inputTokens, outputTokens, errorText: lastError };
    }
    // pi-ai 对上游失败不抛异常：result() 正常 resolve（stopReason='error' + errorMessage），
    // 必须显式检查，否则错误被吞成空回复（status ok、tokens 0）
    if (assistant.stopReason === 'error') {
      lastError = (assistant.errorMessage || '大模型请求失败').slice(0, 200);
      yield { type: 'error', errorText: lastError };
      return { text, thinking, hits, spans, model: model.id, inputTokens, outputTokens, errorText: lastError };
    }
    inputTokens = assistant.usage.input || inputTokens;
    outputTokens = assistant.usage.output || outputTokens;
    // 防丢帧：以最终 message 为准校正文本（缺尾部则补发增量）
    const fullText = assistant.content
      .filter((c): c is (typeof assistant.content)[number] & { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    if (fullText && !roundText.endsWith(fullText)) {
      const missed = fullText.startsWith(roundText) ? fullText.slice(roundText.length) : fullText;
      if (missed) {
        text += missed;
        yield { type: 'text-delta', delta: missed };
      }
    }
    for (const part of assistant.content) {
      if (part.type === 'thinking') thinking += part.thinking;
    }
    if (thinking) yield { type: 'thinking-end' };
    const calls = assistant.content.filter((c): c is ToolCall => c.type === 'toolCall');
    if (!calls.length) break;
    context.messages.push(assistant);
    for (const call of calls) {
      yield { type: 'tool-call', toolName: call.name };
      let args: Record<string, unknown> = {};
      try {
        args = (call.arguments || {}) as Record<string, unknown>;
      } catch {
        args = {};
      }
      // FR-13: 子代理派发（并发上限 3）
      if (call.name === 'subagent_spawn') {
        let spawnResult: string;
        if (Array.from(subagents.values()).filter((s) => s.status === 'running').length >= 3) {
          spawnResult = '子代理数量已达上限（3），请先 subagent_wait_all';
        } else {
          const sub = spawnSubagent(String(args.task || ''));
          spawnResult = `子代理 ${sub.id} 已启动（任务：${sub.task.slice(0, 40)}）`;
          yield { type: 'subagent-spawn', data: { id: sub.id, task: sub.task } };
        }
        yield { type: 'tool-result', toolName: call.name, result: spawnResult };
        context.messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: spawnResult }],
          isError: false,
          timestamp: Date.now(),
        } as Message);
        continue;
      }
      if (call.name === 'subagent_wait_all') {
        const summaries = await waitAll();
        yield { type: 'tool-result', toolName: call.name, result: summaries.slice(0, 2000) };
        // 未通知过的子代理结果通知前端（每个只发一次）
        for (const s of subagents.values()) {
          if (!subNotified.has(s.id)) {
            subNotified.add(s.id);
            yield { type: 'subagent-update', data: { id: s.id, task: s.task, status: s.status, result: s.result, error: s.error } };
          }
        }
        context.messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: summaries }],
          isError: false,
          timestamp: Date.now(),
        } as Message);
        continue;
      }
      const out = await executeTool(input.userId, input.scene, call.name, args, hits, spans);
      yield { type: 'tool-result', toolName: call.name, result: out.slice(0, 2000) };
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: out }],
        isError: false,
        timestamp: Date.now(),
      } as Message);
    }
  }
  // 轮次结束：主 turn 的 data-done 前置条件 = 子代理全部 settle（FR-13 回收）
  if (subagents.size) {
    await Promise.all(Array.from(subagents.values()).map((s) => s.settle));
    for (const s of subagents.values()) {
      if (!subNotified.has(s.id)) {
        subNotified.add(s.id);
        yield { type: 'subagent-update', data: { id: s.id, task: s.task, status: s.status, result: s.result, error: s.error } };
      }
    }
  }
  const draft = input.scene === 'writer' ? extractDraft(text) : undefined;
  if (draft) yield { type: 'data-draft', data: { content: draft } };
  return { text, draft, thinking, hits, spans, model: model.id, inputTokens, outputTokens, ...(lastError ? { errorText: lastError } : {}), ...(retrievalFallback ? { retrievalFallback: true } : {}) };
}

export async function* runChat(input: ChatRunInput): AsyncGenerator<StreamEvent, ChatRunResult> {
  const fn = runner || defaultRunner;
  return yield* fn(input);
}

export async function initAgentRuntime(): Promise<void> {
  mkdirSync(join(process.cwd(), 'data', 'extensions', 'mcp-npm'), { recursive: true });
}
