const DATA_KEY_RE = /^[0-9a-fA-F]{64}$/;

export interface ServerEnv {
  dataKey: Buffer;
  sessionTtlMs: number;
}

let cached: ServerEnv | null = null;

function parseTtlDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 7;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 365) {
    throw new Error('PTDOC_SESSION_TTL_DAYS 必须是 1 到 365 之间的数字');
  }
  return n;
}

/** 校验服务端环境变量。缺失或格式非法时抛出明确错误。 */
export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const key = (env.PTDOC_DATA_KEY || '').trim();
  if (!key) {
    throw new Error('缺少必要环境变量 PTDOC_DATA_KEY（64 位十六进制，32 字节）');
  }
  if (!DATA_KEY_RE.test(key)) {
    throw new Error('PTDOC_DATA_KEY 必须是 64 位十六进制（32 字节）');
  }
  const days = parseTtlDays(env.PTDOC_SESSION_TTL_DAYS);
  return {
    dataKey: Buffer.from(key, 'hex'),
    sessionTtlMs: days * 24 * 60 * 60 * 1000,
  };
}

export function loadServerEnv(env: Record<string, string | undefined>): ServerEnv {
  cached = parseServerEnv(env);
  return cached;
}

export function getServerEnv(): ServerEnv {
  if (!cached) {
    throw new Error('服务端环境尚未加载：请先调用 loadServerEnv');
  }
  return cached;
}

export function resetServerEnvForTests(): void {
  cached = null;
}
