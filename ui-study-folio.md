# Folio Wiki 界面设计研究 → ptdoc 可迁移改进

研究日期：2026-11-11　研究人：mike

## 0. 取证方式（可复现）

| 对象 | 方式 | 说明 |
| --- | --- | --- |
| Folio Wiki | 直接取站点发布的样式表与脚本（`https://wiki.aiops.canwaysoft.com/assets/index-D0EvcAkx.css`，96.8 KB；`index-CpYVnJ52.js`，640.3 KB），在 `/tmp` 解开后逐条读规则 | 该站点未登录只能看到登录弹窗；但其产物 CSS/JS 是公开静态资源，取值比截图目测更准。**未使用 wiki 账号登录，未在任何文件中记录账号信息。** |
| ptdoc 现状 | 读 `src/ui/styles.css`（约 2600 行）+ 用仓库 `styles.css` 渲染测量页，在浏览器里取 `getComputedStyle`；关键项另外在真实 dev server（`npm run dev`，临时数据目录）里对真实文档复测 | 改动前后各测一遍，明暗双主题各一遍；行宽用 `'0'×100` 探针 span 折算 ch |

测量环境：视口 1280×633，`--font-ui` = Inter/system-ui，正文 15px。

## 1. 排版层级

| 项 | Folio 做法 | Folio 实测 | ptdoc 现状（改动前实测） | 建议 |
| --- | --- | --- | --- | --- |
| 正文字号/行高 | 15px / 1.75 | `font-size:15px; line-height:1.75`，色 `#303740` | 15px / 1.7，色 `var(--fg)` | 保持；行高 1.7 已够 |
| h1 | 27px + 1px 分隔线 + 13px 下内距 | `font-size:27px; margin:0 0 25px; padding-bottom:13px; border-bottom:1px var(--line)` | **无字号规则，实测落到 15px（与正文同大）** | 必须修：h1 26px / 1.25 + 分隔线 |
| h2 | 21px + 细分隔线 `#edf0f2`，段前 40px | `margin:40px 0 14px; font-size:21px; padding-bottom:8px` | 22.5px（比 h1 还大，层级倒挂），无分隔线 | 必须修：20px + 分隔线 + 段前 38px |
| h3 / h4 | 17px / 15px，段前 30 / 24px | `margin:30px 0 10px` / `margin:24px 0 8px` | 17.55px（1.17em）/ 15px，段前 24.57 / 19.95px | 17px / 15px，段前 28 / 22px |
| 段落间距 | 16px | `p{margin:0 0 16px}` | 15px | 15px（=1em，保留） |
| 列表密度 | `li{margin:4px 0}` | 4px | **0** | 4px |
| 正文行宽 | **不设上限**，只靠 `padding: clamp(24px,4vw,58px)` | 1440 视口下约 1050px 内容宽 ≈ 140 字符/行 | 1014px ≈ **107 字符/行** | 设 `--measure: 78ch`（约 738px）。**行宽上限是本轮唯一故意偏离 Folio 的一项**，理由见 §10 |
| 强调/链接 | `strong` 720 字重 + `#20262d`；链接 accent + 1px 半透明下划线 | `a{color:var(--accent); border-bottom:1px solid #2468d840}` | **链接无任何规则**：明色 `rgb(0,0,238)`、暗色 `rgb(158,158,255)`，即浏览器默认蓝紫 | 必须修：链接统一走 `--accent`，下划线 1px、偏移 3px |

## 2. 间距节奏

| 项 | Folio | ptdoc |
| --- | --- | --- |
| 基准单位 | 4/5/6/7/8px 混合，非严格 8 网格（`border-radius` 统计：4px×25、5px×14、6px×26、7px×10、8px×8） | 有 `--space-1..6`（4/8/12/16/20/24）与 `--radius: 8px`，但正文与卡片里仍混用 4/6/8/12 |
| 圆角 | 控件 5-6px、卡片/浮层 7-8px、胶囊 9px/999px | 6px×17、8px×11、999px×7、12px×3 |
| 结论 | 两边的圆角阶梯其实很接近，**不需要照抄**；只有"行内代码 4px / 代码块 7-8px / 浮层 8px"这三级值得对齐 | 已对齐 |

## 3. 导航骨架

| 项 | Folio | ptdoc 现状 | 建议 |
| --- | --- | --- | --- |
| 顶栏 | 60px 品牌行 + 42px 文档 tab 行（多 tab，可左右滚动、脏标记圆点、关闭/分屏按钮 hover 才出） | 顶栏单行 + 文档/智能体/分享/设置 四个 tab + 全局搜索 | 不抄多文档 tab：ptdoc 是单文档编辑器，多 tab 会引入文档模型改造，收益不抵成本 |
| 侧栏 | 292px（窄屏 266px），`brand-row` 60px + 上下文块 54px + 树区；**可拖拽调宽**（10px 热区，hover 显示 2px accent 指示线） | 260px，可拖拽（6px 热区 + `--sidebar-w`） | 已具备；热区可从 6px 加到 10px（本轮未做，低优先） |
| 目录树 | 行高 32px，缩进 `calc(7px + depth*14px)`，圆角 5px，字号 12px，选中 = `--accent-soft` + 字重 650，分组头 33px + 18px 计数胶囊 | 行高 32px，字号 13px，圆角 6px，hover 换底色 | 缩进步长与选中态可对齐（本轮未做） |
| 目录/大纲 | 正文右侧独立 220px 面板，`position: sticky`，条目 30px 行高、12px 字、当前项 accent | 有 `.toc`（220px 列） | 已对齐 |
| 面包屑 | 无面包屑，靠"空间 / 版本"上下文块 + 目录树 | 无 | 不需要加 |

## 4. 搜索体验

| 项 | Folio | ptdoc 现状 | 建议 |
| --- | --- | --- | --- |
| 唤起 | `Cmd/Ctrl + K`（脚本里 `(metaKey||ctrlKey) && key==='k'`），另有顶栏按钮 | `Ctrl/Cmd + K`、`Ctrl/Cmd + P`（`app.ts:1583` 同时判 `ctrlKey` 与 `metaKey`），另有顶栏输入框 | 已对齐，不必改 |
| 即时结果 | 250ms 防抖（`setTimeout(...,250)`），浮层紧贴输入框 | 搜索无防抖（触发即查），编辑器渲染防抖 200ms | 两者量级不同但不影响体验；不必改 |
| 高亮 | **不做 `<mark>` 命中高亮**（JS 里 0 处 `mark`） | 不做 | 不抄（都不做，说明这不是刚需） |
| 结果条目 | 最小 70px，`grid-template-columns: 31px minmax(0,1fr)`，31px accent 图标块 + 标题 12px + 路径 9px 等宽 | `.history-item` 10px 12px 内距、圆角 8px | 结构接近；ptdoc 条目更紧凑，保留 |
| 键盘可达 | 有 footer 提示条（35px，9px 字，↑↓/Enter 提示） | 有 ↑↓/Enter | 已对齐 |
| 字号底线 | footer 与路径用 **9px** | 最小 11px | **不抄**：9px 在 1080p 下不可读，ptdoc 保持 ≥11px |

## 5. 内容区细节

| 项 | Folio 实测 | ptdoc 改动前 | 改动后 |
| --- | --- | --- | --- |
| 行内代码 | 前景 `#a63749`，底 `#f6f0f1`，`.88em`，圆角 4px | 底 `--surface` `#f4f6f8`、**无独立前景色**，与页面底对比仅 **1.08**（浅）/1.06（深），几乎看不出是代码 | 浅：`#b23b4e` on `#f7f2f3` 对比 **5.22**；深：`#ff9bab` on `#241b1e` 对比 **8.42** |
| 代码块地面 | **深色块** `#22272e` + 1px `#171b20`，明暗主题共用一套深底 | `--surface` 浅灰，与页面底对比 1.08 / 盘面几乎无边界 | 浅：`#1f252c`（对比正文 **13.08**，块与页面 **15.45**）；深：`#0d1117`（**16.02**）+ 1px 边框 |
| 代码块顶栏 | 34px 条，语言名 `uppercase` 9px 等宽 + 复制按钮（hover 才明显） | **无语言标签、无复制按钮** | 本轮未做，见 §11 |
| 代码字号/行高 | 12px / 1.65，内距 `16px 18px 18px` | 15px（继承正文）/ 1.7，内距 `12px 14px` | 12.5px / 1.65，内距 `14px 16px` |
| 引用块 | 底 `#f5f7f8` + `border-left:3px #8ba9cf` + 内距 `10px 16px` + 段距 22px | 透明底 + `4px var(--border)`，内距 `0 15px`（只有一条灰线） | 底 `--quote-bg` + 3px `--quote-line` + 内距 `10px 16px`，右侧 6px 圆角 |
| 表格 | 13px 字，`th` 底 `--surface-subtle` + 700 字重，`th/td` 内距 `9px 12px`，`tr:nth-child(2n)` 斑马纹，`width:max-content` 横向滚动 | 15px 字，`th` **无底色**，内距 `6px 10px`，无斑马纹 | 13.5px，`th` 底 `--surface` + 600，内距 `8px 12px`，斑马纹 `--table-zebra` |
| 图片 | 1px 边框 + 6px 圆角，`margin: 22px auto` | 仅 `max-width:100%`（直角、无边框） | 1px 边框 + 6px 圆角 |
| 锚点/标题链接 | 标题有 `[data-outline-index]{scroll-margin-top:24px}`，标题内不做永久链接图标 | 有锚点 `#h-xxx`，无 `scroll-margin-top` | 未做（低优先） |

## 6. 主题

| 项 | Folio | ptdoc |
| --- | --- | --- |
| 暗色 | **没有**。整份 CSS 里 `dark` 只出现 1 次（lightningcss 的 `--lightningcss-dark` 占位），也没有 `prefers-color-scheme` 分支 | 完整双主题：`:root` 与 `:root[data-theme="dark"]` 各一套同名 token + `color-scheme` + 首帧脚本防闪白 |
| 语义色组织 | 4 个色族 × 明暗两档（`accent/teal/violet/amber/danger` + `-soft`），中性线 2 档（`--line`/`--line-strong`），文字 4 档（`ink/ink-soft/muted/muted-2`） | `accent/success/warning/danger` + `-soft`/`-line`，文字 3 档（`fg/muted/neutral-fg`） |
| 结论 | **ptdoc 的主题体系比 Folio 完整，绝不能反向照抄成"只有浅色"**。Folio 在浅色主题里给代码块用深底这一招值得学（深底代码块在两种主题下都成立） | 本轮采纳：代码块改为固定深底 + 深色主题下加深 + 1px 边框补偿（深色下块与页面底对比只有 1.07，靠边框分离） |

## 7. 状态与反馈

| 项 | Folio | ptdoc |
| --- | --- | --- |
| 骨架/加载 | 有 `@keyframes shimmer`（240% 背景位移）+ `spin` | 有 `spin`、toast、`dialog`；列表用文字占位 |
| 空/错态 | `.search-prompt` / `--error` 变体（128px 高居中提示）；`.tree-empty`、`.document-outline__empty` | `.tree-empty`（13px 居中）、`.empty` | 
| 结论 | 两边量级相当，ptdoc 不缺；不必新增骨架屏 | — |

## 8. 动效

| 项 | Folio 实测 | ptdoc 实测 |
| --- | --- | --- |
| 时长 | `0.12s`×6、`0.15s`×27、`0.19s`×4、`0.16s`×2；`prefers-reduced-motion` 关闭 4 处 | `--ease: 180ms ease`，另有两处硬编码 `0.18s` |
| 缓动 | 全部 `ease`（无自定义曲线） | `ease` |
| 结论 | 180ms 比 Folio 的 150ms 略钝，但差距在感知阈值内。**本轮不动**，避免全站动效手感跳变 | — |

## 9. 响应式 / 可访问性

| 项 | Folio | ptdoc 现状 | 本轮动作 |
| --- | --- | --- | --- |
| 断点 | 1100/900/800/700/640/600/560/430 + `(hover:hover) and (pointer:fine)` | 860（侧栏抽屉）等 | 不动 |
| 焦点环 | 系统化：`outline:2px solid var(--accent); outline-offset:2~3px`，几乎每个可交互元素都有；另有 `outline-offset:-2px` 的内描边变体 | **只有 `button` 和 `#editor` 有**；`a`/`input`/`select`/`textarea`/`[tabindex]` 全无（浏览器默认环常被容器裁切） | 补齐：`a/input/select/textarea/[tabindex]` 统一 2px accent + 2px 偏移（实测生效：链接与按钮 `:focus-visible` 均命中，`outline-width:2px`）|
| 对比度底线 | 部分文字 9-11px（不达标） | 正文/代码/引用均 ≥4.5（见 §5 数值） | 保持 |

## 10. 本轮落地（分支 `261111-ui-typography`）

纯 CSS 改动，只动 `src/ui/styles.css`，不碰渲染逻辑（`marked` 输出、`mermaid` 二次替换、`build-site.ts` 的正则都依赖现有 `<pre><code>`、标题结构，改 HTML 结构风险不划算）。

| # | 改动 | 关键数值（改动前 → 改动后，实测于真实 dev server，明/暗两主题一致） |
| --- | --- | --- |
| 1 | 标题层级 + 段/列表节奏 | h1 15px → **26px**（并补 1px 分隔线、下内距 10px）；h2 22.5px → **20px**（补细分隔线，段前 31.5 → 38px，段后 18.675 → 12px）；h3 17.55 → 17px；h4 段前 19.95 → 22px、段后 19.95 → 8px；`li` 上下间距 0 → **4px** |
| 2 | 阅读行宽 | 1014px / **107 字符每行** → 738px / **78 字符每行**（`--measure: 78ch`，视口 1280） |
| 3 | 行内代码与代码块 | 行内代码背景与页面底对比 1.08 → 前景 5.22（浅）/ 8.42（深）；代码块背景与页面底对比 1.08 → **15.45**（浅）/ 深色主题 16.02（另加 1px 边框，因为深色下块与底对比仅 1.07）；代码字号 15px → 12.5px、行高 1.7 → 1.65、内距 12×14 → 14×16 |
| 4 | 表格 | 表头底色 透明 → `--surface`（浅 `#f4f6f8` / 深 `#101317`），字重 700 → 600，字号 15 → 13.5px，内距 6×10 → 8×12px，新增斑马纹（浅 `#fafbfc` / 深 `#1b1f24`） |
| 5 | 链接 + 焦点环 | 链接 浏览器默认 `rgb(0,0,238)`（深色 `rgb(158,158,255)`）→ `var(--accent)` + 1px 下划线偏移 3px；`a/input/select/textarea/[tabindex]` 补 2px accent 焦点环（实测 `outline-width:2px; outline-offset:2px`，`:focus-visible` 命中） |
| 6 | 引用块 | 透明底 + 4px 灰线 → 底色 + 3px 线 + 内距 10×16 + 右侧 6px 圆角 |

验证：`npm run typecheck` 通过；`npm test` **93/93 通过**；真实 dev server 明暗双主题实测无横向溢出（`scrollWidth - clientWidth = 0`）、表格与代码块均未超出正文列宽；智能体聊天流（`.agent-md`）的标题尺寸与分隔线已单独覆盖，不受影响。

## 11. Folio 有、但 ptdoc 不该抄 / 本轮不抄

| Folio 的做法 | 为什么不抄 |
| --- | --- |
| **没有暗色主题**（全站只有浅色一套） | ptdoc 的双主题 token 体系比它完整。照抄等于砍掉现有能力。反过来说，Folio 的"浅色主题里代码块用深底"值得学 —— 已采纳 |
| 正文不设行宽上限（`width:100%` + `clamp(24px,4vw,58px)` 内距） | 1440 宽屏下 140+ 字符每行，回扫成本明显；ptdoc 已有 107 字符/行的问题，本轮用 `78ch` 收敛。这是**故意与 Folio 相反**的一处 |
| 9px / 10px 的超小字号（搜索提示条、结果路径、代码语言标签） | 低于可读性底线；ptdoc 保持 ≥11px |
| 表格 `display:block; width:max-content` + 横向滚动 | 会让常规表格塌成内容宽、失去对齐感；ptdoc 保持 `width:100%`，只用底色/斑马纹/内距提升可读性 |
| 多文档 tab 栏（脏标记、分屏、关闭按钮 hover 才出） | ptdoc 是单文档编辑模型，加 tab 要改存储与路由，不属于纯前端低风险改动 |
| 代码块顶栏（语言标签 + 复制按钮） | 值得做，但需要改 `renderMarkdown` 输出结构，而 `build-site.ts` 用 `<pre><code class="language-mermaid">` 正则匹配 mermaid 块，`mermaid.ts` 也靠 `pre > code.language-mermaid` 选择器替换 —— 结构一改就断。**留作独立需求**：先给 mermaid 块加稳定标记，再做代码块顶栏 |
| 语法高亮 token 配色（hljs 主题） | ptdoc 当前未引入高亮器；仅配色不引入解析等于空转，属于另一条依赖决策 |
| Google Fonts 拉 Inter 4 个字重 | 反向建议：Folio 用系统字体栈（`-apple-system, …, PingFang SC, Microsoft YaHei`），零网络请求；ptdoc 的 `fonts.googleapis.com` 在大陆网络/内网下经常超时后回退，首屏会闪一次字体。建议改自托管子集或直接退系统栈（本轮未做，会改全站观感，需要单独确认） |

## 12. 后续待办（按性价比排序）

1. 代码块顶栏（语言标签 + 复制按钮）：先让 mermaid 块带稳定属性，再改渲染结构，最后补 `build-site.ts` 正则。
2. 侧栏树：缩进步长改 14px/depth、选中态 `--accent-soft` + 字重 650（对齐 Folio）；拖拽热区 6px → 10px。
3. 字体：自托管 Inter 子集或退系统栈，去掉 Google Fonts 阻塞。
4. 搜索：结果条目加命中片段摘要（当前只列标题/路径，Folio 同样无 `<mark>` 高亮，优先级低）。
5. 标题锚点 `scroll-margin-top`，避免跳转后标题被顶栏盖住。
