import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
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
}

export interface ChatRunResult {
  text: string;
  draft?: string;
  hits: RetrievedHit[];
  spans: Array<{ name: string; ms: number; ok: boolean; detail?: string }>;
  model: string;
  inputTokens: number;
  outputTokens: number;
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

function openaiTools(scene: 'qa' | 'writer'): unknown[] {
  const tools: unknown[] = [];
  if (scene === 'qa') {
    tools.push({
      type: 'function',
      function: {
        name: 'search_knowledge',
        description: '在远程 Qdrant 知识库中检索相关文档片段',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    });
  } else {
    tools.push(
      {
        type: 'function',
        function: {
          name: 'list_workspace_docs',
          description: '列出当前用户工作区文档',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_workspace_doc',
          description: '读取一篇工作区文档全文',
          parameters: {
            type: 'object',
            properties: { doc_id: { type: 'number' } },
            required: ['doc_id'],
          },
        },
      },
    );
  }
  return tools;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, '');
  if (b.endsWith('/v1')) return b + path;
  return b + '/v1' + path;
}

async function* defaultRunner(input: ChatRunInput): AsyncGenerator<StreamEvent, ChatRunResult> {
  const llm = getLlmProfile(input.userId);
  if (!llm) {
    yield { type: 'error', errorText: '请先在设置中填写大模型 Base URL、API Key 与模型名' };
    return {
      text: '',
      hits: [],
      spans: [],
      model: '',
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  const apiKey = decryptSecret(llm.api_key_enc);
  const skills = readSkillInstructions();
  let currentDoc = '';
  if (input.docId) {
    const d = getDoc(input.userId, input.docId);
    if (d) currentDoc = `# ${d.title}\n\n${d.content}`;
  }
  const system =
    input.scene === 'qa' ? qaInstructions(skills) : writerInstructions(skills, currentDoc);
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: system },
    ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: input.input },
  ];
  const hits: RetrievedHit[] = [];
  const spans: ChatRunResult['spans'] = [];
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const tools = openaiTools(input.scene);
  // plugin tools are executed only if they expose name+execute; otherwise ignored in this loop
  await loadPluginTools();
  void mcpServerConfigs();

  for (let round = 0; round < 6; round++) {
    if (input.abort.aborted) break;
    const res = await fetch(joinUrl(llm.base_url, '/chat/completions'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: llm.model,
        messages,
        stream: true,
        tools: tools.length ? tools : undefined,
      }),
      signal: input.abort,
    });
    if (!res.ok) {
      const err = (await res.text()).slice(0, 200) || '大模型请求失败';
      yield { type: 'error', errorText: err };
      return { text, hits, spans, model: llm.model, inputTokens, outputTokens };
    }
    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: 'error', errorText: '大模型无流式响应' };
      return { text, hits, spans, model: llm.model, inputTokens, outputTokens };
    }
    const dec = new TextDecoder();
    let buf = '';
    let toolCallId = '';
    let toolName = '';
    let toolArgs = '';
    let finish: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = json.choices?.[0];
        const usage = json.usage;
        if (usage) {
          inputTokens = usage.prompt_tokens || inputTokens;
          outputTokens = usage.completion_tokens || outputTokens;
        }
        const delta = choice?.delta || {};
        if (delta.content) {
          text += delta.content;
          yield { type: 'text-delta', delta: delta.content };
        }
        const tc = delta.tool_calls?.[0];
        if (tc) {
          if (tc.id) toolCallId = tc.id;
          if (tc.function?.name) toolName = tc.function.name;
          if (tc.function?.arguments) toolArgs += tc.function.arguments;
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    }
    if (finish === 'tool_calls' && toolName) {
      yield { type: 'tool-call', toolName };
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolArgs || '{}');
      } catch {
        args = {};
      }
      const out = await executeTool(input.userId, input.scene, toolName, args, hits, spans);
      yield { type: 'tool-result', toolName, result: out.slice(0, 2000) };
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: toolCallId || 'call_1', type: 'function', function: { name: toolName, arguments: toolArgs } }],
      });
      messages.push({ role: 'tool', tool_call_id: toolCallId || 'call_1', content: out });
      continue;
    }
    break;
  }
  const draft = input.scene === 'writer' ? extractDraft(text) : undefined;
  if (draft) yield { type: 'data-draft', data: { content: draft } };
  return { text, draft, hits, spans, model: llm.model, inputTokens, outputTokens };
}

export async function* runChat(input: ChatRunInput): AsyncGenerator<StreamEvent, ChatRunResult> {
  const fn = runner || defaultRunner;
  return yield* fn(input);
}

export async function initAgentRuntime(): Promise<void> {
  mkdirSync(join(process.cwd(), 'data', 'extensions', 'mcp-npm'), { recursive: true });
}
