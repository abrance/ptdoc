import { renderMarkdown } from './markdown';

/**
 * 把 Markdown 渲染为自包含 HTML 文档（基础排版样式内联，图片为远程 URL）。
 * 前后端共用：前端「上传 HTML 到七牛 / 下载 HTML」，服务端托管路由 /s/:id。
 */
export function buildShareHtmlDoc(md: string, title = '分享文档'): string {
  const body = renderMarkdown(md);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { margin: 0; background: #fff; color: #1f2328; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.7; }
  .markdown-body { max-width: 860px; margin: 0 auto; padding: 24px 20px; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 { line-height: 1.3; margin-top: 1.4em; }
  .markdown-body h1 { border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
  .markdown-body code { background: #f6f8fa; padding: .15em .4em; border-radius: 4px; font-size: .9em; }
  .markdown-body pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow: auto; }
  .markdown-body pre code { background: none; padding: 0; }
  .markdown-body blockquote { margin: 1em 0; padding: 0 1em; color: #57606a; border-left: 4px solid #d0d7de; }
  .markdown-body table { border-collapse: collapse; width: 100%; }
  .markdown-body th, .markdown-body td { border: 1px solid #d0d7de; padding: 6px 10px; }
  .markdown-body img { max-width: 100%; }
</style>
</head>
<body>
<article class="markdown-body">${body}</article>
</body>
</html>`;
}
