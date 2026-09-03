import { renderMermaidSVG, type RenderOptions } from 'beautiful-mermaid';

// ─── 你的业务逻辑：统一的图表配色主题 ────────────────────────────
// 改这里即可让全站 Mermaid 图保持一致风格（浅色、便于阅读与截图）。
// 也可改用 beautiful-mermaid 自带的 THEMES，或 fromShikiTheme(theme)。
// 导出供静态站点构建（scripts/build-site.ts）复用同一配色。
//
// 当前方案 = 深海蓝（专业商务风、冷调）：
//   - 节点：surface(极浅蓝) 打底 + border(浅蓝) 描边，呈现柔和的浅色卡片；
//   - 箭头/强调：accent(蓝) 是全图唯一的"点睛色"，与节点同族互相呼应；
//   - 连线与次要文字：line / muted 用中性的石板灰，不抢视觉；
//   - 主文字：fg 用近乎黑的深石板蓝，对比度高、稳重。
export const DIAGRAM_THEME: RenderOptions = {
  bg: '#ffffff',      // 画布背景（保持白，融入文档页面）
  fg: '#0f172a',      // slate-900  主文字（节点标签）
  line: '#94a3b8',    // slate-400  连接线（清淡不抢戏）
  accent: '#2563eb',  // blue-600   箭头 / 强调（点睛色）
  muted: '#64748b',   // slate-500  次要文字（边标签、分组标题）
  surface: '#f0f4ff', // 极浅蓝      节点背景填充（浅蓝卡片）
  border: '#bfd0f5',  // 浅蓝        节点边框（与填充同族）
  font: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  transparent: false,
};

// ─── 内容线条样式（沉淀一套美化后的默认线型）────────────────────
// beautiful-mermaid 渲染器把线型参数写死在内部（src/styles.ts / renderer.ts）：
//   实线 1px、粗线 2px、点线 1px + "4 4" 破折号、箭头多边形描边 0.75px、直角连接。
// 这些参数没有暴露在 RenderOptions 里，这里通过向 SVG 注入 CSS 规则统一覆盖，
// 让 flowchart / sequence / class / er 各类型的连接线柔和、清晰、风格一致。
// 改这一处即可全站生效（预览、静态站点、分享版 PNG 共用同一套样式）。
export const LINE_STYLES = {
  /** 实线连接线宽（默认 1px，加粗更清晰） */
  solid: 1.5,
  /** 加粗连接线宽（flowchart 的 ==> / ===，默认 2px） */
  thick: 2.5,
  /** 点线/虚线连接线宽（默认 1px） */
  dotted: 1.25,
  /** 点线破折号 pattern（默认 "4 4"；圆角线帽下呈现柔和小点） */
  dottedPattern: '2 3.5',
  /** 箭头多边形描边（默认 0.75px，与加粗后的连接线保持协调） */
  arrowStroke: 1.1,
} as const;

/** 注入到 SVG <style> 的线型覆盖规则。 */
const LINE_STYLE_CSS = `
    /* ── ptdoc 内容线条美化：覆盖 beautiful-mermaid 默认线型 ── */
    polyline.edge,
    polyline.class-relationship,
    polyline.er-relationship,
    g.message > line,
    g.message > polyline {
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: ${LINE_STYLES.solid};
    }
    polyline.edge[data-style="dotted"] {
      stroke-width: ${LINE_STYLES.dotted};
      stroke-dasharray: ${LINE_STYLES.dottedPattern};
    }
    polyline.edge[data-style="thick"] { stroke-width: ${LINE_STYLES.thick}; }
    marker[id^="arrowhead"] polygon { stroke-width: ${LINE_STYLES.arrowStroke}; }
    marker[id="seq-arrow-open"] polyline { stroke-width: ${LINE_STYLES.solid}; }`;

// ─── 分组（subgraph）配色 ──────────────────────────────────────
// beautiful-mermaid 里 subgraph 区域填充写死为画布背景（--_group-fill: var(--bg)），
// 头部条由 fg 5% 派生（--_group-hdr），两者都没有公开的 RenderOptions 字段。
// 这里注入 CSS 变量覆盖，让分组区域成为独立的浅色容器，与节点卡片形成层级。
// 注意：--_group-hdr 同时被 sequence 的 loop/alt 标签条、class 头部条、ER 实体头部使用，
// 因此这些部位会随此值一起变成同族浅蓝（视觉一致）。
export const GROUP_STYLES = {
  /** subgraph 区域填充（默认 = 画布背景 --bg） */
  fill: '#f8fafc',
  /** subgraph 头部条（默认 = fg 5% 派生的浅灰） */
  header: '#e8efff',
} as const;

const GROUP_STYLE_CSS = `
    svg {
      --_group-fill: ${GROUP_STYLES.fill};
      --_group-hdr: ${GROUP_STYLES.header};
    }`;

/** 把 ptdoc 样式覆盖规则注入 SVG（找不到 <style> 时兜底在 </svg> 前补一个）。 */
function applySvgStyleOverrides(svg: string): string {
  const css = `${LINE_STYLE_CSS}\n${GROUP_STYLE_CSS}`;
  if (svg.includes('</style>')) {
    return svg.replace('</style>', `${css}\n  </style>`);
  }
  return svg.replace('</svg>', `<style>${css}\n</style>\n</svg>`);
}

/** 把一段 Mermaid 源码渲染为 SVG 字符串（同步，浏览器/Node 通用）。 */
export function renderMermaidToSvg(code: string): string {
  return applySvgStyleOverrides(renderMermaidSVG(code.trim(), DIAGRAM_THEME));
}

/**
 * 把一段 Mermaid 源码渲染为 SVG 字符串（同步，浏览器/Node 通用）。
 * 同时把 CSS 变量内联成真实色值，确保后续光栅化为 PNG 时颜色正确。
 */
const CSS_VARS: Record<string, string> = {
  '--bg': DIAGRAM_THEME.bg ?? '#ffffff',
  '--fg': DIAGRAM_THEME.fg ?? '#1f2328',
  '--line': DIAGRAM_THEME.line ?? '#8b949e',
  '--accent': DIAGRAM_THEME.accent ?? '#2563eb',
  '--muted': DIAGRAM_THEME.muted ?? '#57606a',
  '--surface': DIAGRAM_THEME.surface ?? '#f6f8fa',
  '--border': DIAGRAM_THEME.border ?? '#d0d7de',
};

function inlineCssVars(svg: string): string {
  return svg.replace(/var\((--[\w-]+)\)/g, (_, name: string) => CSS_VARS[name] ?? `var(${name})`);
}

/**
 * 把 Mermaid 源码渲染成 PNG Blob（用于「分享版」时上传到图床）。
 * 流程：renderMermaidSVG -> SVG 字符串 -> Image -> Canvas -> PNG。
 */
export function renderMermaidToPngBlob(code: string, scale = 2): Promise<Blob> {
  const svg = inlineCssVars(renderMermaidToSvg(code.trim()));
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const w = Math.max(1, Math.ceil(img.naturalWidth || 0) || 400);
      const h = Math.max(1, Math.ceil(img.naturalHeight || 0) || 300);
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        return reject(new Error('canvas 不可用'));
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('PNG 生成失败'))),
        'image/png',
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG 渲染为图片失败'));
    };
    img.src = url;
  });
}

/** 对 Mermaid 源码做稳定哈希（用于图片与源码的映射元信息）。 */
export function hashMermaid(code: string): number {
  let h = 5381;
  const s = code.trim();
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * mermaid 内容缓存版本。图表配色 / 线条样式等主题变化时自增，
 * 使旧主题的缓存失效（避免复用错误样式的图）。
 */
export const MERMAID_CACHE_VERSION = 6;

/** 对 Mermaid 源码做 SHA-256 哈希，作为图床去重的稳定键。 */
export async function sha256Mermaid(code: string): Promise<string> {
  const data = new TextEncoder().encode(MERMAID_CACHE_VERSION + '|' + code.trim());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 在给定容器内，把所有 ```mermaid 代码块替换为渲染后的 SVG。
 * 这是「胶水」：让 Markdown 渲染结果中的图表自动可视化。
 */
export function renderMermaidBlocks(container: HTMLElement): void {
  const blocks = container.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  blocks.forEach((codeEl) => {
    const pre = codeEl.parentElement;
    if (!pre) return;
    const source = codeEl.textContent ?? '';
    try {
      const svg = renderMermaidToSvg(source);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-render';
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'mermaid-error';
      note.textContent = 'Mermaid 渲染失败：' + (err as Error).message;
      pre.replaceWith(note);
    }
  });
}
