import { sha256Mermaid } from './mermaid';

/**
 * 「当前文档 vs 最近一次发布」一致性检查（纯逻辑，前端调用，无网络副作用）。
 *
 * 对比思路：分享版 md 里每个 mermaid 代码块已被替换成 `![图 N](远程URL)` 一行，
 * 且 shares 关联的 images 表记录了每个图表的 mermaid 内容哈希。于是：
 *  - 图表：对当前文档的 mermaid 代码块做同样哈希，与发布时的哈希序列做 LCS 对比；
 *  - 文字：把当前文档去掉 mermaid 块、把分享版 md 去掉图片替换行，得到两份"纯文字"，
 *    做行级 LCS 统计改动行数；
 *  - 当哈希序列完全一致时，用发布时的 URL 重建"当前文档的分享形态"，与 share_md
 *    精确比对（能抓到纯空白/顺序级差异，避免误报）。
 *
 * 注意：哈希包含 MERMAID_CACHE_VERSION，若主题版本升级，同一内容会判定为"修改"——
 * 这是合理的（重新发布确实会产生不同的图），提示用户重新发布即可。
 */

export interface ShareImageRef {
  url: string;
  mermaid_hash: string | null;
}

/** 一次分享记录的发布基准（share_md + 图表映射）。 */
export interface PublishBaseline {
  share_md: string;
  images: ShareImageRef[];
}

export type DiagramStatus = 'same' | 'modified' | 'added';

/** 当前文档里第 index（1 起）个图表的状态。 */
export interface DiagramChange {
  index: number;
  status: DiagramStatus;
}

export interface PublishDiff {
  /** 是否有可比的发布基准（当前文档没有分享记录时为 false，不提示） */
  hasBaseline: boolean;
  /** 内容是否与上次发布完全一致（文字 + 图表） */
  consistent: boolean;
  /** 文字改动行数（纯文字的行级增删行数） */
  textChanges: number;
  /** 当前文档图表的变更明细（按出现顺序） */
  diagrams: DiagramChange[];
  /** 发布版里被删除的图表位置（1 起，按发布版顺序） */
  removed: number[];
}

const MERMAID_FENCE = /```mermaid\s*\n([\s\S]*?)```/g;
const IMG_LINE = /^!\[图\s*\d+\]\((.+)\)$/;

export interface MermaidBlock {
  code: string;
  start: number;
  end: number;
}

/** 按顺序提取文档里的 mermaid 代码块（与生成分享版同一套正则）。 */
export function extractMermaidBlocks(md: string): MermaidBlock[] {
  const out: MermaidBlock[] = [];
  for (const m of md.matchAll(MERMAID_FENCE)) {
    out.push({ code: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** 去掉 mermaid 代码块后的纯文字（用于文字对比；块被替换为空串以对齐换行）。 */
export function stripMermaidText(md: string): string {
  return md.replace(MERMAID_FENCE, '');
}

/** 去掉分享版 md 里由 mermaid 替换成的图片行（按 URL 是否属于该分享的图片判定）。 */
export function stripShareImageLines(shareMd: string, imageUrls: Set<string>): string {
  return shareMd
    .split('\n')
    .filter((line) => {
      const m = line.match(IMG_LINE);
      return !(m && imageUrls.has(m[1]));
    })
    .join('\n');
}

/** 行级 LCS 统计增删行数；超长文档退化为近似值（避免 O(n*m) 过慢）。 */
export function countLineChanges(a: string, b: string): number {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 2_000_000) {
    // 近似：按行内容多重集计数差异
    const count = new Map<string, number>();
    for (const l of A) count.set(l, (count.get(l) ?? 0) + 1);
    let diff = 0;
    for (const l of B) {
      const c = count.get(l) ?? 0;
      if (c > 0) count.set(l, c - 1);
      else diff++;
    }
    for (const c of count.values()) diff += c;
    return diff;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let changes = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      changes++;
      i++;
    } else {
      changes++;
      j++;
    }
  }
  return changes + (n - i) + (m - j);
}

/** 当前哈希序列 vs 发布哈希序列的 LCS 对比：未匹配块按序 1:1 配对，位置相邻视为"修改"。 */
function diffHashes(cur: string[], prev: string[]): { diagrams: DiagramChange[]; removed: number[] } {
  const n = cur.length;
  const m = prev.length;
  const prevSet = new Set(prev);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = cur[i] === prev[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchedCur: boolean[] = new Array(n).fill(false);
  const matchedPrev: boolean[] = new Array(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (cur[i] === prev[j]) {
      matchedCur[i] = true;
      matchedPrev[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  const unmatchedCur: number[] = [];
  for (let k = 0; k < n; k++) if (!matchedCur[k]) unmatchedCur.push(k);
  const unmatchedPrev: number[] = [];
  for (let k = 0; k < m; k++) if (!matchedPrev[k]) unmatchedPrev.push(k);

  const statusOf: Array<'same' | 'modified' | 'added'> = new Array(n).fill('added');
  for (let k = 0; k < n; k++) if (matchedCur[k]) statusOf[k] = 'same';
  const consumedPrev: boolean[] = new Array(m).fill(false);
  for (const k of unmatchedCur) {
    const pi = unmatchedPrev.find((p) => !consumedPrev[p] && Math.abs(p - k) <= 1);
    if (pi !== undefined) {
      statusOf[k] = 'modified';
      consumedPrev[pi] = true;
    } else {
      // 当前哈希在发布序列里出现过（重排/重复场景）也算修改，否则是新增
      statusOf[k] = prevSet.has(cur[k]) ? 'modified' : 'added';
    }
  }
  const removed: number[] = [];
  for (let k = 0; k < m; k++) {
    if (!matchedPrev[k] && !consumedPrev[k] && !cur.includes(prev[k])) removed.push(k + 1);
  }
  const diagrams: DiagramChange[] = statusOf.map((s, k) => ({ index: k + 1, status: s }));
  return { diagrams, removed };
}

/**
 * 计算当前文档与最近一次发布的差异。
 * baseline 为 null 表示没有发布记录（视为无基准，不提示）。
 */
export async function diffPublish(currentMd: string, baseline: PublishBaseline | null): Promise<PublishDiff> {
  if (!baseline) {
    return { hasBaseline: false, consistent: true, textChanges: 0, diagrams: [], removed: [] };
  }

  const blocks = extractMermaidBlocks(currentMd);
  const curHashes = await Promise.all(blocks.map((b) => sha256Mermaid(b.code)));

  // 发布侧：从 share_md 还原图表哈希序列（按顺序），并收集图片 URL 集合
  const urlToHash = new Map<string, string>();
  for (const im of baseline.images) {
    if (im.mermaid_hash) urlToHash.set(im.url, im.mermaid_hash);
  }
  const shareUrls = new Set(baseline.images.map((i) => i.url));
  const shareHashes: string[] = [];
  for (const line of baseline.share_md.split('\n')) {
    const m = line.match(IMG_LINE);
    if (m && shareUrls.has(m[1])) {
      const h = urlToHash.get(m[1]);
      if (h) shareHashes.push(h);
    }
  }

  // 文字改动（两边的"纯文字"）
  const curText = stripMermaidText(currentMd);
  const shareText = stripShareImageLines(baseline.share_md, shareUrls);
  const textChanges = countLineChanges(curText, shareText);

  // 图表全部一致时：用发布 URL 重建分享形态做精确比对
  let consistent = false;
  if (shareHashes.length === curHashes.length && curHashes.every((h, k) => h === shareHashes[k])) {
    const hashToUrl = new Map<string, string>();
    for (const im of baseline.images) {
      if (im.mermaid_hash) hashToUrl.set(im.mermaid_hash, im.url);
    }
    let rebuilt = '';
    let cursor = 0;
    let ok = true;
    for (let k = 0; k < blocks.length; k++) {
      rebuilt += currentMd.slice(cursor, blocks[k].start);
      const url = hashToUrl.get(curHashes[k]);
      if (!url) {
        ok = false;
        break;
      }
      rebuilt += `![图 ${k + 1}](${url})\n`;
      cursor = blocks[k].end;
    }
    if (ok) {
      rebuilt += currentMd.slice(cursor);
      consistent = rebuilt === baseline.share_md;
    }
  }

  const { diagrams, removed } = diffHashes(curHashes, shareHashes);
  return { hasBaseline: true, consistent, textChanges, diagrams, removed };
}
