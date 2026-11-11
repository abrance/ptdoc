---
name: ptdoc
description: >-
  Read and write PTDoc workspace documents (Markdown + Mermaid + 图床) over REST
  (curl) or the ptdocctl CLI: list documents, get one doc, create/update in place,
  delete, search, batch pull/push sync, upload images, create share records, read a
  share page, snapshot and roll back, archive metadata. Use it whenever asked to
  read, write, sync or search PTDoc documents, or to script PTDoc from CI or an
  agent.
  Triggers: "ptdoc", "ptdocctl", "PTDoc 文档", "PTDoc 仓库", "拉取文档", "上传文档",
  "ptdoc 同步", "文档搜索", "ptdoc 搜索", "生成分享链接", "分享页", "文档快照",
  "回滚文档", "归档文档", "ptdoc token", "PTDOC_TOKEN", "PTDoc API", "ptdoc curl".
---

# PTDoc

PTDoc 是一个个人 Markdown 文档工具：文档存 SQLite，图片走七牛，图表走 mermaid。
本文件的事实源就在仓库里，跟着代码版本走；接口全量矩阵见
`references/api.md`，命令行细节见 `references/ptdocctl.md`。

## 两条通道，先选一条

| 你想做的事 | 用哪条 | 理由 |
| --- | --- | --- |
| 脚本 / CI / 智能体批量同步文档 | `ptdocctl` | 一条命令完成 pull/push/pushr，无需拼 JSON |
| 改标题、删单篇、搜关键字、看归档 | `ptdocctl` | 子命令齐全，输出人类可读 |
| 智能体只要拿结构化数据（JSON） | REST `curl` | CLI 没有 JSON 输出模式 |
| 生成分享记录、写快照、读分享页、管用户 | REST `curl` | CLI 没有对应子命令 |
| 上传图片 | REST `curl` | 唯一入口是 `POST /api/upload` |

先定一个变量，后面所有示例都用它：

```bash
export PTDOC_URL="https://ptdoc.xiaoyxq.top"   # 自建实例换成本机地址，如 http://127.0.0.1:5173
export PTDOC_TOKEN="..."                        # 见下节「认证」
```

## 认证

两种等价方式，任选其一：

- **静态 Token（推荐给脚本）**：请求头 `Authorization: Bearer $PTDOC_TOKEN`。
- **登录会话**：`POST /api/auth/login` 拿 `ptdoc_session` Cookie，后续带上 Cookie。

Token 的关键事实（很容易踩）：

- Token **由你自己指定**，服务端不生成也不回显。规则：16–64 位**纯字母数字**
  （`^[A-Za-z0-9]{16,64}$`），含 `-`/`_`/`.` 会被拒。
- 设置即覆盖：`POST /api/auth/token` 你传什么，之后就只认什么；`DELETE` 则清空。
- 服务端只存 SHA-256 哈希，**丢了只能重设**。
- Token 绝不写进仓库、URL 或截图。本仓库是公开仓库，一律走环境变量 `$PTDOC_TOKEN`。

```bash
# 设置/轮换 Token（这里用登录会话）；password 至少 8 位
NEW_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"   # 32 位十六进制
curl -s -c /tmp/ptdoc.jar -X POST "$PTDOC_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"verifier","password":"verify-pass-123"}'

curl -s -b /tmp/ptdoc.jar -X POST "$PTDOC_URL/api/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$NEW_TOKEN\"}"
```

真实返回：

```json
{"ok":true,"has_api_token":true}
```

> 示例里的 `verifier` / `verify-pass-123` 是验证实例里的一次性账号（该实例已销毁），
> 线上不存在；换成你自己的用户名密码即可。

## 连接自检

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/auth/me"
```

```json
{"id":1,"username":"verifier","role":"admin","status":"active","created_at":1794369851621,"has_api_token":true}
```

Token 无效/未带：

```json
{"error":"未登录"}
```

HTTP 401。CLI 侧等价命令是 `ptdocctl whoami`。

## 任务：列出全部文档

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/docs"
```

```json
[{"id":1,"doc_key":"ops/deploy.md","title":"部署手册","filename":"deploy.md","updated_at":1794369854032,"last_opened_at":1794369854032}]
```

注意：列表**不含正文**，只有 id / doc_key / 标题 / 时间戳（毫秒）。要正文用
`/api/docs/full` 或单篇接口。数据按账号隔离，别人的文档在这里看不到。

## 任务：读单篇

按数字 id（唯一可靠的方式）：

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/docs/1"
```

```json
{"id":1,"user_id":1,"doc_key":"ops/deploy.md","title":"部署手册","filename":"deploy.md","content":"# 部署手册\n\n正文第一版。\n","created_at":1794369854032,"updated_at":1794369854032,"last_opened_at":1794369854032,"archive_path":null,"qdrant_sync_share_id":null,"qdrant_synced_at":null}
```

只想拿正文：

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/docs/1" | jq -r .content
# 或者一条命令按 doc_key 找：ptdocctl get ops/deploy.md
```

id 不存在或属于别人：HTTP 404 `{"error":"不存在"}`。

## 任务：建文档

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$PTDOC_URL/api/docs" \
  -d '{"doc_key":"ops/deploy.md","title":"部署手册","filename":"deploy.md","content":"# 部署手册\n\n正文第一版。\n"}'
```

```json
{"id":1,"doc_key":"ops/deploy.md"}
```

`doc_key` 就是路径式唯一键（`ops/deploy.md`），`filename` 是展示用文件名，`title`
取 md 首个 `# ` 标题。CLI 侧 `ptdocctl push deploy.md` 会自动填这三项。

## 任务：原地更新

同一个 `doc_key` 再 POST 一次即可，**id 不变、不会产生新文档**：

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$PTDOC_URL/api/docs" \
  -d '{"doc_key":"ops/deploy.md","title":"部署手册","filename":"deploy.md","content":"# 部署手册\n\n正文第二版：加了回滚步骤。\n"}'
```

```json
{"id":1,"doc_key":"ops/deploy.md"}
```

再读一次确认 `content` 变了、`created_at` 不变、`updated_at` 变了：

```json
{"id":1,"user_id":1,"doc_key":"ops/deploy.md","title":"部署手册","filename":"deploy.md","content":"# 部署手册\n\n正文第二版：加了回滚步骤。\n","created_at":1794369854032,"updated_at":1794369854046,"last_opened_at":1794369854046,"archive_path":null,"qdrant_sync_share_id":null,"qdrant_synced_at":null}
```

改 `doc_key` 本身用重命名接口：

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$PTDOC_URL/api/docs/1/rename" -d '{"new_key":"ops/deploy-v2.md"}'
```

```json
{"ok":true}
```

## 任务：搜索

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/docs?q=%E5%9B%9E%E6%BB%9A"
```

（`%E5%9B%9E%E6%BB%9A` = URL 编码的「回滚」，也可以直接写中文让 curl 编码）

```json
[{"id":1,"doc_key":"ops/deploy.md","title":"部署手册","filename":"deploy.md","updated_at":1794369854046,"last_opened_at":1794369854046}]
```

实现是 SQL `LIKE %q%`，匹配 `title` / `filename` / `content` 三处，大小写不敏感，
按最近打开排序，最多 50 条。**不支持**正则、分词、`AND/OR` 语法。CLI 等价：
`ptdocctl search 回滚`。

## 任务：全量同步（批量 pull / push）

```bash
# 全量拉取：一个请求拿所有文档正文，落盘 <doc_key>.md
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/docs/full" \
  | jq -r '.[] | "\(.doc_key)\u0000\(.content)"' >/dev/null   # 便于看清结构，落盘请用 CLI

# 推荐用 CLI 做双向同步
export PTDOC_URL PTDOC_TOKEN
ptdocctl pull /tmp/ptdoc-docs          # 全量下载 → /tmp/ptdoc-docs/<doc_key>.md
diff -ru /tmp/ptdoc-docs ./docs        # 先看差异
ptdocctl pushr ./docs                  # 递归上传，doc_key 含子目录路径
```

`/api/docs/full` 的返回是一条 JSON 数组，元素结构与「读单篇」相同。`pushr` 以相对
路径为 `doc_key`，同 key 重复上传是原地更新，按 key 幂等，失败重跑即可。

## 任务：删文档

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -X DELETE "$PTDOC_URL/api/docs/1"
```

```json
{"ok":true}
```

删除只吃数字 id，**不吃 doc_key**（CLI 的 `delete` 会先 `list` 帮你换算，所以 CLI 里
两种写法都能用）。

## 任务：快照与回滚

```bash
# 打快照（label 可省）
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$PTDOC_URL/api/docs/1/snapshots" -d '{"label":"v2 前存档"}'
```

```json
{"id":1}
```

```bash
# 列出快照（含各自正文）
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/docs/1/snapshots"
```

```json
[{"id":1,"doc_id":1,"content":"# 部署手册\n\n正文第二版：加了回滚步骤。\n","label":"v2 前存档","created_at":1794369857062}]
```

```bash
# 回滚：把快照正文写回文档当前工作副本
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -X POST "$PTDOC_URL/api/docs/1/snapshots/1/restore"
# 删快照
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -X DELETE "$PTDOC_URL/api/docs/1/snapshots/1"
```

```json
{"ok":true}
```

回滚**只覆盖文档正文，不自动生成「回滚前」的新快照**——所以回滚前先手动打一个，
否则当前版本就没了。快照没有列表分页，也没法跨文档查询。

## 任务：上传图片

前提：账号已配好七牛（`GET /api/upload` 返回 `{"configured":true}`）。上传是**裸二进制
body**，不是 multipart，文件名走 `x-filename` 头：

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" \
  -H 'x-filename: shot.png' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @shot.png \
  "$PTDOC_URL/api/upload"
```

返回结构（`POST /api/upload` → `uploadToQiniu` 的返回值）：

```json
{"key":"uploads/2026/11/xxxx-shot.png","url":"https://cdn.example.com/uploads/2026/11/xxxx-shot.png"}
```

> **未实测**：本仓库验证环境没有七牛密钥，上面这条只跑到错误分支——未配置存储时返回
> HTTP 400 `{"error":"请先完成对象存储配置"}`；配置了假凭据时 `PUT /api/storage` 返回
> HTTP 400 `{"error":"七牛连通性校验失败（HTTP 401）：{\"error\":\"bad token\",...}"}`。
> 成功返回的字段名来自源码 `qiniu-uploader.ts` 的返回结构，未经真实上传验证。

可选头：`x-key-prefix`（对象 key 前缀）、`x-source: mermaid|share|direct`（媒体库归类，
`share` 不入媒体库）。`GET /api/upload` 只用来查是否已配置。

## 任务：生成分享记录

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$PTDOC_URL/api/share" \
  -d '{"doc_key":"ops/deploy.md","share_md":"# 部署手册\n\n正文第二版：加了回滚步骤。\n","images":[]}'
```

```json
{"id":1}
```

`share_md` 是**发布时的正文快照**（以后改文档不会影响已生成的分享）。`images` 是
`[{"qiniu_key":"...","url":"...","mermaid_hash":null}]`，没有图就传空数组。可选 `md_url`
/ `html_url` 记录外部已上传的链接；`html_url` 也会让这篇文档进入归档列表。

改分享记录的 html 链接、列分享、读一条、删一条：

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$PTDOC_URL/api/share/1/html" -d '{"html_url":"https://cdn.example.com/share/1.html"}'
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/share"             # 全部；?doc_key= 过滤
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/share/1"           # 单条，含 images
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -X DELETE "$PTDOC_URL/api/share/1"
```

```json
{"ok":true}
```

## 任务：读分享页

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/s/1" > share-1.html
```

返回一整个自包含 HTML 页面（`<title>分享文档</title>`，内联 CSS）：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>分享文档</title>
<style>
  body { margin: 0; background: #fff; color: #1f2328; ... }
  .markdown-body { max-width: 860px; margin: 0 auto; padding: 24px 20px; }
```

**注意**：`/s/<id>` 也要认证，不带 Token/Cookie 直接请求返回 **HTTP 401**（实测）。也就是说
分享页目前是「给自己/已登录账号看的渲染页」，不是公开外链；要对外分享得用 `share.md` /
`html_url` 里传到图床的那份。

## 任务：归档

```bash
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/archive"           # 归档树
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" "$PTDOC_URL/api/archive?q=deploy"  # 过滤
curl -s -H "Authorization: Bearer $PTDOC_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$PTDOC_URL/api/docs/1/archive-path" -d '{"archive_path":"ops/历史/deploy.md"}'
```

```json
{"entries":[{"id":1,"doc_key":"ops/deploy.md","title":"部署手册","archive_path":"ops/deploy.md","share_id":1,"html_url":"https://cdn.example.com/share/1.html","md_url":null,"created_at":1794369859714,"stale":false,"qdrant_sync":"none","qdrant_synced_at":null}],"folders":[]}
```

只有生成过分享（**且 `html_url` 不为空**）的文档才进归档。所以执行顺序有讲究：先发分享、再写
`archive_path`。上一步如果刚把分享删了，这里会拿到 HTTP 400：

```json
{"error":"文档尚未归档"}
```

目录管理：`POST /api/archive/folders`（`{"path":"ops/历史"}`）、
`POST /api/archive/folders/rename`（`{"from","to"}`）、
`DELETE /api/archive/folders?path=ops%2F%E5%8E%86%E5%8F%B2`。目录里还有归档文档时删不掉：

```json
{"error":"文件夹内还有归档文档"}
```

Qdrant 同步 `POST /api/docs/1/qdrant-sync` 也需要先归档，否则同样的 400 `文档尚未归档`。

## 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| HTTP 401 `{"error":"未登录"}` | 没带 `Authorization: Bearer`，或 Token 已被 `DELETE /api/auth/token` 清掉 |
| HTTP 400 `API Token 为 16–64 位字母或数字` | Token 里有 `-`/`_`/`.`，换成纯字母数字 16–64 位 |
| HTTP 401 `用户名或密码错误` / 连续 5 次后 429 | 登录失败计数 5 次锁 15 分钟，换 Token 通道或等锁过期 |
| HTTP 404 `{"error":"不存在"}` | 文档 id 不存在或属于别的账号（数据按账号隔离，表现为 404 而不是 403） |
| HTTP 400 `请先完成对象存储配置` | 上传/删图前要在「设置」里配七牛并通过连通性校验 |
| `delete <doc_key>` 报错 | REST 删除只认数字 id；用 CLI 或先 `GET /api/docs` 换 id |
| 搜索结果为空但正文里明明有 | 只做 `LIKE %q%` 子串匹配，且最多 50 条；关键词别带正则/通配符 |
| 分享页打不开（401） | `/s/<id>` 需要认证，不是公开链接 |
| HTTP 400 `文档尚未归档` | 写 `archive-path` 或 `qdrant-sync` 前，这篇文档要有一个带 `html_url` 的分享 |
| HTTP 400 `文件夹内还有归档文档` | 先移走/清理目录里的归档，再删目录 |

## 相关文件

- `references/api.md`：全量端点矩阵（方法 / 路径 / 认证 / 入参 / 返回 / 源码行号）
- `references/ptdocctl.md`：CLI 子命令、实测行为与限制
- 仓库 README 的 `## ptdocctl 命令行客户端`、`## 给智能体用的 skill 物料` 两节
