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
import { getDoc, getLlmProfile, getQdrantProfile, listAllDocs } from './db.ts';
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

function qaInstructions(skills: string): string {
  return [
    '你是 PTDoc 知识库问答助手。优先用 search_knowledge 检索后再回答。',
    '引用检索片段，不要编造来源。未命中时明确说明。',
    '回答正文中在引用检索片段处标注角标 [1] [2]（编号对应检索返回顺序），便于溯源。',
    skills,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function writerInstructions(skills: string, currentDoc?: string): string {
  return [
    '你是 PTDoc Markdown 编写助手。只输出可写回的 Markdown。完整草稿放在 markdown 代码围栏中。',
    '使用 list_workspace_docs / read_workspace_doc 阅读工作区；不要声称已写入磁盘。',
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
      const profile = getQdrantProfile(userId);
      if (!profile) throw new Error('请先在设置中填写 Qdrant URL 与 collection');
      const apiKey = profile.api_key_enc ? decryptSecret(profile.api_key_enc) : undefined;
      const found = await retrieveHits(
        {
          url: profile.url,
          apiKey,
          collection: profile.collection,
          vectorName: profile.vector_name || undefined,
          topK: profile.top_k,
        },
        String(args.query || ''),
      );
      hits.push(...found);
      spans.push({ name, ms: Date.now() - t0, ok: true, detail: String(found.length) });
      return JSON.stringify(found);
    }
    if (name === 'list_workspace_docs') {
      const docs = listAllDocs(userId).map((d) => ({ doc_key: d.doc_key, title: d.title, id: d.id }));
      spans.push({ name, ms: Date.now() - t0, ok: true });
      return JSON.stringify(docs);
    }
    if (name === 'read_workspace_doc') {
      const id = Number(args.doc_id);
      const doc = Number.isFinite(id) ? getDoc(userId, id) : undefined;
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

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** 场景工具定义（TypeBox schema，由 pi-ai 转换成各 provider 的 wire 格式） */
function sceneTools(scene: 'qa' | 'writer'): PiTool[] {
  if (scene === 'qa') {
    return [
      {
        name: 'search_knowledge',
        description: '在远程 Qdrant 知识库中检索相关文档片段',
        parameters: Type.Object({ query: Type.String({ description: '检索查询词' }) }),
      },
    ];
  }
  return [
    {
      name: 'list_workspace_docs',
      description: '列出当前用户工作区文档',
      parameters: Type.Object({}),
    },
    {
      name: 'read_workspace_doc',
      description: '读取一篇工作区文档全文',
      parameters: Type.Object({ doc_id: Type.Number({ description: '文档 id' }) }),
    },
  ];
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

/** 外部历史消息 → pi-ai 消息（历史里没有工具调用记录，工具轮消息只在本次会话内产生） */
function toPiMessages(input: ChatRunInput): Message[] {
  const out: Message[] = [];
  for (const m of input.messages) {
    if (m.role === 'system') continue; // system 由 Context.systemPrompt 承载
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      timestamp: Date.now(),
    } as Message);
  }
  out.push({ role: 'user', content: input.input, timestamp: Date.now() } as Message);
  return out;
}

async function* defaultRunner(input: ChatRunInput): AsyncGenerator<StreamEvent, ChatRunResult> {
  const built = buildModels(input.userId);
  if (!built) {
    yield { type: 'error', errorText: '请先在设置中填写大模型 Base URL、API Key 与模型名' };
    return { text: '', hits: [], spans: [], model: '', inputTokens: 0, outputTokens: 0 };
  }
  const { models, model, thinkingLevel } = built;
  const skills = readSkillInstructions();
  let currentDoc = '';
  if (input.docId) {
    const d = getDoc(input.userId, input.docId);
    if (d) currentDoc = `# ${d.title}\n\n${d.content}`;
  }
  const context: Context = {
    systemPrompt:
      input.scene === 'qa' ? qaInstructions(skills) : writerInstructions(skills, currentDoc),
    messages: toPiMessages(input),
    tools: sceneTools(input.scene),
  };
  const hits: RetrievedHit[] = [];
  const spans: ChatRunResult['spans'] = [];
  let text = '';
  let thinking = '';
  let inputTokens = 0;
  let outputTokens = 0;
  // plugin tools are executed only if they expose name+execute; otherwise ignored in this loop
  await loadPluginTools();
  void mcpServerConfigs();

  const streamOpts = { signal: input.abort, reasoningEffort: thinkingLevel === 'off' ? undefined : thinkingLevel };

  let lastError: string | null = null;
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
      if ((e as Error).name === 'AbortError') break;
      lastError = ((e as Error).message || '大模型请求失败').slice(0, 200);
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
    if (assistant.stopReason === 'toolUse' && calls.length > 0) {
      context.messages.push(assistant);
      for (const call of calls) {
        yield { type: 'tool-call', toolName: call.name };
        let args: Record<string, unknown> = {};
        try {
          args = (call.arguments || {}) as Record<string, unknown>;
        } catch {
          args = {};
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
      continue;
    }
    break;
  }
  const draft = input.scene === 'writer' ? extractDraft(text) : undefined;
  if (draft) yield { type: 'data-draft', data: { content: draft } };
  return { text, draft, thinking, hits, spans, model: model.id, inputTokens, outputTokens, ...(lastError ? { errorText: lastError } : {}) };
}

export async function* runChat(input: ChatRunInput): AsyncGenerator<StreamEvent, ChatRunResult> {
  const fn = runner || defaultRunner;
  return yield* fn(input);
}

export async function initAgentRuntime(): Promise<void> {
  mkdirSync(join(process.cwd(), 'data', 'extensions', 'mcp-npm'), { recursive: true });
}
