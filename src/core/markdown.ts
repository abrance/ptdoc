import { marked } from 'marked';

// 基础 Markdown 渲染配置（GFM，便于写表格/任务列表等）。
marked.setOptions({ gfm: true, breaks: false });

/**
 * 把 Markdown 文本渲染为 HTML 字符串。
 * Mermaid 代码块会被保留为 <pre><code class="language-mermaid">，
 * 由 mermaid.ts 的 renderMermaidBlocks 在 DOM 中二次替换为 SVG。
 */
export function renderMarkdown(md: string): string {
  // marked.parse 在无非异步扩展时为同步返回 string
  return marked.parse(md) as string;
}
