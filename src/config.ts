// 站点配置（前端安全，仅含非敏感的展示项）。
// VITE_ 前缀的变量来自 .env，构建时注入；缺省时使用下方的默认值。
export const siteConfig = {
  title: import.meta.env.VITE_SITE_TITLE || 'PTDoc · 我的 Markdown 文档站',
  defaultDoc: import.meta.env.VITE_DEFAULT_DOC || '/docs/index.md',
};
