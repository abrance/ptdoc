import { completeSimple, type Model } from '@earendil-works/pi-ai/compat';

/** 探测结果：ok 只表示「上游确实回话了」，details 给人排查用，不参与判断。 */
export interface ProbeResult {
  ok: boolean;
  /** 上游 HTTP 状态；0 表示没拿到响应（DNS/超时/连接被拒） */
  status: number;
  /** 成功时的关键信息（模型名 / 向量维度），失败时为空 */
  detail: string;
  /** 失败时给人看的排查提示；成功时可为空 */
  hint: string;
  /** 上游原始响应前 200 字符，配错时有它才知道到底哪里错 */
  raw?: string;
}

function joinV1(base: string): string {
  const b = base.replace(/\/$/, '');
  return b.endsWith('/v1') ? b : b + '/v1';
}

function flat(text: string, n = 200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, n);
}

/** 从上游错误里挖出更可执行的提示，比只回 「HTTP 401」 有用。 */
function llmHint(status: number, raw: string): string {
  // 模型名锉在 403 里（服务商常把「分组不支持该模型」当权限错报），先认 raw 再认状态码
  if (/model/i.test(raw) && /not support|not found|unknown|invalid|does not/i.test(raw)) {
    return '模型名不被该账号/分组接受：检查拼写，或看 raw 里的 Available models';
  }
  if (status === 0) return '连不上 Base URL：检查地址、端口与是否需要代理（DNS 或连接被拒）';
  if (status === 401 || status === 403) return '鉴权失败：检查 API Key 是否正确、是否已过期';
  if (status === 404) return '端点不存在：Base URL 通常要带 /v1，模型名要与服务商一致';
  if (status === 429) return '被限流或额度耗尽：稍后重试或检查账户余额';
  if (status >= 500) return '上游服务端错误：稍后重试，或换一个模型名';
  return '上游拒绝了请求，看 raw 里的原始报错';
}

/**
 * LLM 最小可用性探测：发一条 1 token 的 chat。
 * 复用 agent-runtime 的同一套 provider 构造，否则「自检通过但实际跑不通」。
 */
export async function probeLlm(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinkingLevel?: string;
}): Promise<ProbeResult> {
  const model: Model<'openai-completions'> = {
    id: opts.model,
    name: opts.model,
    api: 'openai-completions',
    provider: 'ptdoc-llm-probe',
    baseUrl: joinV1(opts.baseUrl),
    reasoning: opts.thinkingLevel !== 'off',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16,
  };

  try {
    const out = await completeSimple(
      model,
      { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
      { maxTokens: 16, apiKey: opts.apiKey, signal: AbortSignal.timeout(20000) },
    );
    // pi-ai 对上游失败不抛异常，要自己看 stopReason
    if (out.stopReason === 'error') {
      const raw = flat(String(out.errorMessage || ''));
      const m = raw.match(/\b(4\d{2}|5\d{2})\b/);
      const status = m ? Number(m[1]) : 0;
      return { ok: false, status, detail: '', hint: llmHint(status, raw), raw };
    }
    const reply = out.content
      .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('')
      .trim();
    return {
      ok: true,
      status: 200,
      detail: `${opts.model} 可用（返回 ${reply.length} 字符）`,
      hint: '',
    };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const m = msg.match(/\b(4\d{2}|5\d{2})\b/);
    const status = m ? Number(m[1]) : 0;
    return { ok: false, status, detail: '', hint: llmHint(status, msg), raw: flat(msg) };
  }
}

/**
 * Qdrant 连通性探测：读 collection info，拿向量维度。
 * 用 GET /collections/:name 而不是 query，因为后者在没数据或未启用服务端向量化时会误报失败。
 */
export async function probeQdrant(opts: {
  url: string;
  collection: string;
  apiKey?: string;
  vectorName?: string | null;
}): Promise<ProbeResult> {
  const base = opts.url.replace(/\/$/, '');
  const target = `${base}/collections/${encodeURIComponent(opts.collection)}`;

  // /qdrant/ 前缀（ptdoc-qdrant-gateway 的形态）直接把路径拼在后面，其余按裸 Qdrant 处理
  const attempt = async (url: string): Promise<{ status: number; text: string }> => {
    try {
      const res = await fetch(url, {
        headers: opts.apiKey ? { 'api-key': opts.apiKey } : {},
        signal: AbortSignal.timeout(10000),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { status: 0, text: (e as Error).message || 'fetch failed' };
    }
  };

  let r = await attempt(target);
  // 网关形态：base 已经含 /qdrant 时上面就对了；不带前缀的服务端在 404 时补试一次
  if (r.status === 404 && !/\/qdrant$/.test(base)) {
    const alt = await attempt(target.replace(base, base + '/qdrant'));
    if (alt.status !== 404) r = alt;
  }

  if (r.status === 0) {
    return { ok: false, status: 0, detail: '', hint: '连不上 Qdrant URL：检查地址、端口与网络可达性', raw: flat(r.text) };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, status: r.status, detail: '', hint: '鉴权失败：检查 Qdrant API Key', raw: flat(r.text) };
  }
  if (r.status === 404) {
    return {
      ok: false,
      status: 404,
      detail: '',
      hint: `collection「${opts.collection}」不存在：先在知识库里建好并写入数据，或检查 URL 是否要带 /qdrant 前缀`,
      raw: flat(r.text),
    };
  }
  if (r.status >= 400) {
    return { ok: false, status: r.status, detail: '', hint: 'Qdrant 返回错误，看 raw 里的原始报错', raw: flat(r.text) };
  }

  try {
    const j = JSON.parse(r.text) as {
      result?: { config?: { params?: { vectors?: Record<string, { size?: number }> | { size?: number } } } };
    };
    const vectors = j.result?.config?.params?.vectors;
    if (!vectors) return { ok: true, status: r.status, detail: `collection「${opts.collection}」可访问`, hint: '' };
    // 未命名向量是 {size}，命名向量是 {name: {size}}
    if ('size' in vectors) {
      const size = (vectors as { size?: number }).size;
      return { ok: true, status: r.status, detail: `collection「${opts.collection}」维度 ${size}`, hint: '' };
    }
    const names = Object.keys(vectors as Record<string, { size?: number }>);
    const wanted = opts.vectorName && names.includes(opts.vectorName) ? opts.vectorName : names[0];
    const size = (vectors as Record<string, { size?: number }>)[wanted]?.size;
    const missing = opts.vectorName && !names.includes(opts.vectorName);
    return {
      ok: true,
      status: r.status,
      detail: `collection「${opts.collection}」维度 ${size}（向量名 ${wanted}）`,
      hint: missing ? `注意：配置的 vector 名「${opts.vectorName}」不在该 collection 里（现有：${names.join(', ')}）` : '',
    };
  } catch {
    return { ok: true, status: r.status, detail: `collection「${opts.collection}」可访问`, hint: '', raw: flat(r.text) };
  }
}
