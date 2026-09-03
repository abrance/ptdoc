# PTDoc

个人 Markdown 文档工具：整合 **Markdown 渲染 + Mermaid 图表 + 七牛云图床**，用于编写与展示 `.md` 文档。

定位是一个「**胶水代码 + 你自己的业务逻辑 + 依赖库**」的组合，方便你逐步往里塞自己的需求，而不是被某个重框架绑死。

## 功能

- ✍️ 左侧写 Markdown，右侧实时预览
- 📊 ` ```mermaid ` 代码块自动渲染为 SVG（[`beautiful-mermaid`](https://github.com/lukilabs/beautiful-mermaid)）
- 🖼️ 一键把本地 PNG 上传到七牛云对象存储，返回 URL 自动插入文档（图床）；顶栏「媒体库」集中管理所有上传图片（直接上传 + mermaid 图），支持搜索/筛选、复制 URL、插入光标处、删除（二次确认）
- 📤 **「生成分享版」**：把文档里所有 ` ```mermaid ` 图表渲染成 PNG 上传七牛，自动替换为远程图片链接的 md；同时把这份 md 与渲染好的自包含 HTML 一起上传七牛（`share/` 目录），得到两份**永久公开链接**——适合直接发给别人，也可**「下载 HTML」**本地保存
- 🏗️ **静态站点发布（build-site）**：一条命令把全部文档渲染为自包含静态站点（mermaid 内联 SVG、站内互链、左侧导航、MiniSearch 全文搜索），产物 `dist-site/` 可直接拷到任意静态服务器部署
- 📁 **多文档工作区**：左侧文档树按路径分层展示全部文档，支持新建/重命名/删除/过滤/**批量导入文件夹**（📥 选目录递归导入，同名自动跳过），当前文档高亮；预览区内 `[](相对路径.md)` 点击即可在工作区内跳转（互链）
- 📑 **预览目录 TOC**：顶栏「目录」开关，自动生成 h1~h3 大纲，点击平滑滚动定位；锚点 id 稳定，重渲染不跳错
- 🔍 **跨文档全文搜索**：`Ctrl/Cmd+K`（或 `Ctrl/Cmd+P`）唤起，输入即检索所有文档的标题/文件名/正文（MiniSearch，前缀+模糊），结果带命中片段，↑↓ 选择回车打开
- 🔗 **分享记录管理**：顶栏「分享记录」查看所有历史分享，每条记录可直接**查看 HTML**（新标签页打开七牛上的渲染页）、**查看 MD**（弹窗展示分享版 md 内容）、一键复制永久链接（七牛 HTML 或托管链接）、删除记录（不影响七牛上已发布的 HTML）
- 🕘 **版本快照**：顶栏「快照」为当前文档保存命名快照（不可变记录），支持只读预览、一键恢复（恢复前自动留兜底快照）、删除；自动保存的工作副本与快照解耦
- 🕘 **文档历史 / 最近打开**：打开过的 md 全文存入本地 SQLite，按"最近打开"排序展示；用 File System Access API 记住文件句柄，点历史/最近即可直接重开**真实磁盘文件**，无需再选路径（句柄失效时回退数据库快照）
- 📄 默认加载 `public/docs/index.md`，也可打开本地 `.md` 文件

## 目录结构（胶水 / 业务 / 依赖 三层）

```
ptdoc/
├── package.json            # 依赖库声明（beautiful-mermaid / marked / qiniu / minisearch / vite）
├── vite.config.ts          # 构建 + 把图床上传接口挂到 dev/preview 服务端
├── .env.example            # 七牛云配置模板
├── index.html              # 页面骨架
├── public/
│   └── docs/index.md       # 你的 md 内容（可放多篇）
├── scripts/
│   └── build-site.ts       # 静态站点发布（Node 24 直接跑 TS）
├── data/                  # 本地 SQLite 数据库（自动生成，已 gitignore）
│   └── ptdoc.db
└── src/
    ├── config.ts           # 前端站点配置（标题 / 默认文档）
    ├── core/               # ── 客户端胶水 + 你的业务逻辑 ──
    │   ├── markdown.ts     #   marked 渲染流水线（纯 md→html）
    │   ├── mermaid.ts      #   beautiful-mermaid 封装 + 图表配色 + mermaid→PNG
    │   ├── slug.ts         #   标题锚点 slug（TOC 与静态站点共用）
    │   └── share-html.ts   #   分享 HTML 模板（前后端共用）
    ├── server/             # ── Node 端胶水（密钥/数据库不出服务端）──
    │   ├── qiniu-uploader.ts  # qiniu SDK 封装 + key 命名规则
    │   ├── upload-api.ts      # /api/upload 中间件（图床）
    │   ├── db.ts              # SQLite（node:sqlite）建表与 CRUD
    │   └── api.ts             # /api/docs、/api/share、/s/:id 等中间件
    └── ui/                 # ── 界面 ──
        ├── app.ts          #   编辑器 / 预览 / 上传 / 分享 / 历史 / 快照
        ├── sidebar.ts      #   侧边栏文档树（路径分层、增删改查、互链入口）
        ├── toc.ts          #   预览区目录大纲（锚点注入 + 滚动高亮）
        ├── media.ts        #   媒体库抽屉（缩略图网格 / 复制 / 插入 / 删除）
        ├── fileHandles.ts  #   File System Access API 句柄持久化
        └── styles.css
```

约定：

- **依赖库**：`package.json` 里声明的第三方包。
- **胶水**：`src/core`（前端）与 `src/server`（后端）把依赖库接成可用能力。
- **你的业务逻辑**：`core/mermaid.ts` 的图表配色、`server/qiniu-uploader.ts` 的对象 key 命名规则——改这两处即可定制。

## 快速开始

```bash
npm install
cp .env.example .env      # 填写七牛云 QINIU_* 配置（不上传图片可先跳过）
npm run dev               # 打开 http://localhost:5173
```

服务监听 `0.0.0.0`（局域网/容器内可直接访问），端口可在 `.env` 里改：`PORT`（开发服务器，默认 5173）、`PREVIEW_PORT`（预览服务器，默认 4173）；也可以命令行临时指定，例如 `PORT=8080 npm run dev` 或 `npm run dev -- --port 8080`（CLI 优先级最高）。

构建静态站点：

```bash
npm run build-site        # 生成 dist-site/（mermaid 内联 SVG + 导航 + 搜索）
npm run preview-site      # 本地预览静态站点 http://localhost:4174
npm run build             # 构建编辑器应用（产物在 dist/）
npm run typecheck         # 仅做类型检查
```

> `build-site` 需要 Node 24（直接用 `node --experimental-strip-types` 跑 TS）。站点产物纯静态，可整体拷贝到任意静态服务器；搜索使用 MiniSearch 客户端索引（`dist-site/index.json`）。

## Docker 部署到服务器

仓库自带 `build/Dockerfile`、`deploy/docker-compose/` 与根目录 `Makefile`，一条命令即可在服务器上跑起来。镜像用 `vite preview` 同时提供编辑器页面与 `/api/*`（上传 / 文档 / 分享）接口，行为与本地 preview 一致；SQLite 库与静态站点产物通过挂载卷持久化到宿主机。

```bash
# 1. 在服务器上准备配置（复制示例并填写七牛密钥与端口）
cd deploy/docker-compose
cp .env.example .env

# 2. 回到项目根，一条命令构建并启动
cd ../..
make up
# 打开 http://<服务器IP>:4173
```

常用操作（都在项目根执行）：

| 命令 | 作用 |
| --- | --- |
| `make up` | 构建镜像并后台启动（服务器一键部署） |
| `make logs` / `make ps` | 查看日志 / 服务状态 |
| `make restart` | 重启服务（`git pull` 更新代码后常用） |
| `make down` | 停止并移除容器（`data/` 数据保留） |
| `make site` | 在容器内重新生成静态站点 → `dist-site/` |
| `make deploy-site SITE=user@host:/var/www/ptdoc` | 把静态站点 rsync 到服务器任意目录 |
| `make help` | 查看全部命令 |

要点：

- **数据**：SQLite 库在 `data/ptdoc.db`，容器内 `/app/data` 挂载自宿主机，删除容器不丢数据。
- **配置**：部署配置在 `deploy/docker-compose/.env`（`PTDOC_PORT` 为对外端口，`QINIU_*` 为七牛密钥）。改了 `VITE_*` 站点配置需重新 `make up` 重建镜像；只改 `QINIU_*` 或端口可 `make restart`。
- **静态站点**：`dist-site/` 依赖运行期数据库中的文档，在容器里按需生成（`make site`）；生成后可交给任意静态服务器，或直接用 `make deploy-site` 同步。
- **七牛密钥可缺省**：不填 `QINIU_*` 也能正常启动，只是上传 / 分享功能不可用，日志里会提示。

## 本地 dev 服务（systemd）

想让它常驻后台、开机自启，可用仓库自带的 `deploy/systemd/ptdoc-dev.service`：

```bash
sudo cp deploy/systemd/ptdoc-dev.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ptdoc-dev    # 开机自启 + 立即启动
```

常用：`systemctl status ptdoc-dev` 看状态，`journalctl -u ptdoc-dev -f` 跟随日志，`sudo systemctl restart ptdoc-dev` 重启。

- 端口默认 5173；在项目 `.env` 里加一行 `PORT=8080` 即可改（unit 用 `EnvironmentFile` 把 `.env` 注入进程环境，`PORT` 才会真正生效——vite 自身的 `loadEnv` 不回写 `process.env`）。
- unit 里 `ExecStart` 用的是 nvm 安装路径，升级 Node 后记得同步修改。

## 配置七牛云图床

在 [七牛开发者平台](https://portal.qiniu.com) 创建存储桶，把密钥填入 `.env`：

| 变量 | 说明 |
| --- | --- |
| `QINIU_AK` | AccessKey |
| `QINIU_SK` | SecretKey（仅服务端使用，不会进入前端打包） |
| `QINIU_BUCKET` | 存储桶名称 |
| `QINIU_DOMAIN` | 访问域名（含协议，如 `https://cdn.example.com`） |
| `QINIU_ZONE` | 区域：`Zone_z0` 华东 / `Zone_z1` 华北 / `Zone_z2` 华南 / `Zone_na0` 北美 / `Zone_as0` 东南亚 |
| `QINIU_PRIVATE` | 是否私有桶：`true` 时下载 URL 带签名且会过期（`false` 则直接返回公开 URL） |
| `QINIU_URL_TTL` | 私有桶签名 URL 有效期（秒），默认 3600 |

> ⚠️ **私有桶用于文档图床的注意点**：私有桶返回的下载 URL 带 `?e=...&token=...`，仅在 `QINIU_URL_TTL` 秒内有效，**过期后文档里的图片会加载失败**。如果你的 md 文档需要长期稳定显示图片，建议把存储桶设为「公开」（`QINIU_PRIVATE=false`）；若必须私有，则应在渲染文档时实时重新签发 URL（属于进阶改造，需要时可告知）。

上传流程：浏览器把图片二进制 POST 到本地 dev server 的 `/api/upload` → Node 端用 `qiniu` SDK 上传 → 返回 `{ url }` → 前端插入 `![](url)`。**密钥始终留在服务端**，前端只拿到最终 URL。

## 分享版与历史

### 「生成分享版」做什么

点击顶栏「生成分享版」后，会把当前文档里**所有** ` ```mermaid ` 代码块：

1. 用 `beautiful-mermaid` 渲染成 SVG；
2. 在浏览器里光栅化成 PNG（SVG→`<img>`→`<canvas>`→PNG，CSS 变量已内联保证颜色正确）；
3. 逐张上传到七牛云图床（复用 `/api/upload`）；
4. 把原 mermaid 代码块替换成 `![图 N](远程URL)`；
5. 把替换后的分享版 md 上传到七牛 `share/` 目录（`.md` 永久链接）；
6. 把分享版 md 渲染成自包含 HTML（图片已是远程 URL）也上传到七牛 `share/` 目录（`.html` 永久链接，无需部署、无需常驻服务器）；
7. 弹出分享版 md，可**复制**、**下载 .md** 或**下载 HTML**；
8. 同时把映射元信息写入 SQLite（`shares` + `images` 表），`.md`/`.html` 永久链接分别记入 `md_url` / `html_url` 字段。

> 此外 dev/preview 环境还提供托管路由 `GET /s/:id`：直接访问即可实时渲染对应分享记录（链接 = `http://localhost:5173/s/<id>`），适合本地快速查看；公网永久链接仍以上述七牛方式为主。

这样发出去的 md 不再依赖 mermaid 渲染器，别人用任何 Markdown 阅读器都能看到图片。

### 发布一致性检查

打开文档或编辑内容时，会实时（输入后约 1 秒防抖）把当前文档与**最近一次发布**做对比——纯前端离线比对，不产生网络上传：

- 图表：对当前文档的 mermaid 代码块做与发布时相同的内容哈希，与分享记录里的哈希序列对比（能识别**修改 / 新增 / 删除**）；
- 文字：把 mermaid 块与图片替换行剥离后做行级对比，统计改动行数。

有未发布的改动时，「生成分享版」按钮右上角出现红色角标（数字 = 文字改动处数 + 图表变更个数），点角标可查看差异摘要；直接点「生成分享版」会先弹出差异确认，再继续生成。内容一致或无发布记录时不提示。注意：图表配色/线条主题升级（`MERMAID_CACHE_VERSION` 自增）会让相同内容被判为"修改"，重新发布一次即可。

### 历史与搜索

打开或编辑过的 md 全文会写入本地 `data/ptdoc.db` 的 `docs` 表（按 `doc_key` 去重更新，并记录 `last_opened_at` 用于"最近打开"排序）。

- **记住文件路径（句柄）**：在支持 File System Access API 的浏览器（Chromium 系，localhost 属于安全上下文）中，"打开 .md"会拿到可持久化的 `FileSystemFileHandle` 存入 IndexedDB。之后在「历史」里点该文档，会直接用句柄读取**真实磁盘文件**，不再弹文件选择框；句柄失效时回退到从数据库内容打开。不支持的浏览器自动回退到传统文件框（此时重开的是数据库快照）。
- **最近打开**：历史列表按 `last_opened_at` 倒序，标注"x 分钟前 / x 小时前"。
- **快速打开 / 补全**：`Ctrl/Cmd+K` 或 `Ctrl/Cmd+P` 唤起搜索框，输入即实时过滤，可用 ↑↓ 选择、回车打开（命令面板式补全体验）。
> 浏览器出于隐私不会暴露完整磁盘路径字符串，因此"路径信息"以"文件名 + 可持久化句柄"形式存在，重开无需重新选择。

### 数据模型（SQLite）

| 表 | 作用 |
| --- | --- |
| `docs` | 打开过的 md：doc_key / 标题 / 文件名 / 全文 / 时间 |
| `shares` | 每次生成的分享版 md 文本（含 `md_url` / `html_url`：上传七牛的 .md / .html 永久链接） |
| `images` | 分享版里每张图：七牛 key / URL / mermaid 源码哈希 |
| `media` | **媒体库**：所有上传的图片（来源 direct / mermaid、文件名、大小、时间） |
| `mermaid_cache` | **按内容去重的图床缓存**：mermaid 源码 SHA-256 → 已上传图片 URL（相同图表不再重传） |

> 相同 mermaid 内容（含主题版本号）只会上传一次；再次「生成分享版」会直接复用缓存里的远程 URL。修改图表配色/线条样式后把 `MERMAID_CACHE_VERSION` 自增即可让旧缓存失效。若手动删除了桶里的某张图，对应缓存需手动清库（`data/ptdoc.db`）。

## 如何扩展

- **改图表配色**：编辑 `src/core/mermaid.ts` 的 `DIAGRAM_THEME`（背景/文字/线条/强调色等）。
- **改图表线条样式**：编辑 `src/core/mermaid.ts` 的 `LINE_STYLES`（连接线宽、点线破折号、箭头描边；通过向 SVG 注入 CSS 覆盖 `beautiful-mermaid` 内部写死的默认线型，预览/静态站点/分享版 PNG 三处共用）。
- **改图表分组配色**：编辑 `src/core/mermaid.ts` 的 `GROUP_STYLES`（subgraph 区域填充色、头部条颜色；注入 CSS 变量覆盖库默认，同样三处共用）。
- **改上传路径规则**：编辑 `src/server/qiniu-uploader.ts` 的 `buildKey`。
- **加更多渲染能力**：在 `src/core/markdown.ts` 注入 marked 扩展（代码高亮、数学公式等）。
- **多文档站点**：把 `.md` 放进 `public/docs/`，在 `src/ui/app.ts` 增加文档列表与路由。
- **线上也能上传**：当前图床接口随 dev/preview 服务端运行；若要部署后也可上传，需把 `src/server/upload-api.ts` 的逻辑搬到一个 Serverless/Node 接口上。
