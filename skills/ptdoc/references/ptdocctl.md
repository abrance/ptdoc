# ptdocctl 命令行客户端

`ptdocctl/` 是本仓库自带的客户端（纯 Go 标准库，零依赖），适合脚本 / CI / 智能体做
批量拉取和推送。它调用的是 `references/api.md` 里那套 REST 接口——**同一套接口的两种
外壳**，行为差异只在输出格式上，不要按两套事实理解。

- 源码：`ptdocctl/main.go`（单文件，`go build` 即得）
- 最新发布：GitHub Releases 上的 `v1.4.x` 之后逐版递增，当前 line 为 `v1.7.x`；
  制品名 `ptdocctl-v<tag>-<os>-<arch>.tar.gz`（另附 `SHA256SUMS`）。用 `latest/download`
  拿最新版，别把版本号写死在脚本里
- 本仓库**不存放二进制**：需要就用下面的安装方式取，别把 tar 包提交进仓库

## 安装

```bash
# 方式一：从 Releases 下载（Linux amd64 示例；macOS/arm64/windows 换对应制品名）
# 用 GitHub API 取最新 tag 再拼文件名，避免写死版本
TAG=$(curl -fsSL https://api.github.com/repos/abrance/ptdoc/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
curl -fsSLO "https://github.com/abrance/ptdoc/releases/latest/download/ptdocctl-v${TAG}-linux-amd64.tar.gz"
tar xzf "ptdocctl-v${TAG}-linux-amd64.tar.gz" && sudo install -m755 "ptdocctl-v${TAG}-linux-amd64" /usr/local/bin/ptdocctl

# 方式二：源码编译（需要 Go ≥ 1.21）
make ptdocctl-install          # 装到 /usr/local/bin/ptdocctl
# 或者只构建不安装：
cd ptdocctl && go build -o /tmp/ptdocctl .
```

## 全局参数

```
--url <地址>    服务地址，必需，如 https://ptdoc.xiaoyxq.top
--token <t>     静态 API Token（推荐），与浏览器 Cookie 等价
--user <name>   无 Token 时用用户名 + 密码登录
--pass <pw>     同上
--space <s>     空间名或 id：读命令按它过滤，写命令落该空间；缺省时读=全部、写=默认空间
--force         push/pull 覆盖前比内容，冲突时强行覆盖（push 先打快照；pull 先留 .bak-<ts>）
```

参数可放在子命令前后，也支持 `--token=xxx` 连写。缺 `--url` 或缺认证时直接报错退出，
不会发请求：

```
缺少 --url，例如 --url http://localhost:5173
缺少 --token（或 --user 与 --pass）
```

建议先落一个变量，后面都用它：

```bash
export PTDOC_URL="https://ptdoc.xiaoyxq.top"
export PTDOC_TOKEN="..."          # 16–64 位字母数字，自己设定，绝不写进仓库
C="ptdocctl --url $PTDOC_URL --token $PTDOC_TOKEN"
```

## 子命令

| 子命令 | 作用 | 实际请求 | 输出 |
| --- | --- | --- | --- |
| `whoami` | 连接与身份自检 | `GET /api/auth/me` | `user=<name> id=<id> role=<role> server=<url>` |
| `list` | 列出文档（`--space` 时只列该空间） | `GET /api/docs[?space=]` | `id<TAB>doc_key<TAB>标题` |
| `get <doc_id\|doc_key>` | 打印全文 | `GET /api/docs` 定位，再 `GET /api/docs/<id>` | 正文原文（无行号、无装饰） |
| `search <keyword>` | 搜标题/正文 | `GET /api/docs?q=` | `id<TAB>doc_key<TAB>标题` |
| `pull [dir]` | 全量拉取（`--space` 时只拉该空间） | `GET /api/docs/full[?space=]` | `已写入 <path>` / `共拉取 N 个文档 → <dir>` |
| `push <file>...` | 上传，doc_key=文件名 | 每个文件 `POST /api/docs`（带 `space_id`） | `已上传 <file> → <doc_key>`；被服务端改名时附「服务端改写为 …」 |
| `pushr <dir>` | 递归上传，doc_key 含子目录 | 同上，串行 | 每行 `已上传 …` + `共上传 N 个文件` |
| `delete <doc_id\|doc_key>` | 删文档 | 先定位，再 `DELETE /api/docs/<id>` | `已删除 <id><TAB><doc_key>` |
| `rename <doc> <new_key>` | 改 doc_key（文件名/路径） | `POST /api/docs/<id>/rename` | `已重命名 <id><TAB><旧> → <新>` |
| `title <doc> <标题>` | 改标题，正文不动 | `POST /api/docs`（原 doc_key + 原正文 + 原 space_id） | `已改标题 <id><TAB><key> → <标题>` |
| `versions <doc>` | 版本列表（倒序，无正文） | `GET /api/docs/<id>/versions?limit=50` | `id<TAB>kind<TAB>时间<TAB>大小<TAB>sha7<TAB>label` |
| `version <doc> <vid>` | 打印某个版本的正文 | `GET /api/docs/<id>/versions/<vid>` | 正文原文 |
| `snapshot <doc> [label]` | 手动存一个版本 | `POST /api/docs/<id>/versions` | `已保存版本 <vid><TAB><doc_key>` |
| `restore <doc> <vid>` | 回滚到某个版本 | `POST /api/docs/<id>/versions/<vid>/restore` | `已回滚 … （回滚前内容存为版本 <n>）` |
| `export [file]` | 导出全站 md 为 zip（`--space` 时只导该空间） | `GET /api/docs/export.zip[?space=]` | `已导出 <N> B → <file>` |

实测（独立实例 5199，源码构建；`--space` 与 FR-31 冲突检测在 v1.7.x，新增的
rename/title/versions/version/snapshot/restore/export 在 v1.8.0）：

```
$ ptdocctl … whoami
user=e2e id=1 role=admin server=http://127.0.0.1:5199

$ ptdocctl … pushr /tmp/e2e-docs
已上传 /tmp/e2e-docs/a.md → a.md
已上传 /tmp/e2e-docs/sub/b.md → sub/b.md
共处理 2 个文件，实际上传 2 个

$ ptdocctl … --space 工作 push /tmp/e2e-work.md
已上传 /tmp/e2e-work.md → e2e-work.md

$ ptdocctl … rename sub/b.md renamed/b.md
已重命名 2	sub/b.md → renamed/b.md

$ ptdocctl … title renamed/b.md '改名后的标题'
已改标题 2	renamed/b.md → 改名后的标题

$ ptdocctl … versions renamed/b.md
5	manual	2026-11-16 12:27:59	24 B	0ccdfb9	第二版
4	manual	2026-11-16 12:27:59	24 B	0ccdfb9	发版前
2	auto	2026-11-16 12:26:41	24 B	0ccdfb9	

$ ptdocctl … restore renamed/b.md 2
已回滚 renamed/b.md 到版本 2（回滚前内容存为版本 7）

$ ptdocctl … --space 工作 export /tmp/e2e-work.zip
已导出 543 B → /tmp/e2e-work.zip

$ ptdocctl … push /tmp/e2e-docs/a.md        # 两边都改过
检测到 1 个内容冲突（本地与远端都改过），未覆盖：
  a.md	本地 2026-11-16T12:29:20+08:00	远端 2026-11-16T12:26:41+08:00
确认要覆盖请加 --force
ptdocctl: 检测到 1 个内容冲突，已中止        # 退出码 1
```

## 行为细节（写脚本前必读）

- `push` 的 `doc_key` = 文件名（`foo.md` → `foo.md`）；不带 `.md` 后缀会自动补。
  一个文件里的 **首个 `# ` H1** 会成为文档标题，没有 H1 时用文件名去掉 `.md`。
- 同一个 `doc_key` 重复 `push` 是**原地更新**（服务端按 `doc_key` upsert），不会产生新文档。
- `pushr` 的 `doc_key` = 相对 `pushr <dir>` 传入目录的路径（`pushr ./docs` 遇到
  `./docs/a/b.md` 时 key 为 `a/b.md`），保证子目录结构能还原。串行提交，遇到失败以非零码
  退出，**按 doc_key 幂等，重跑即可**。
- `pull` 用 `doc_key` 作落盘路径（`ops/deploy.md` → `<dir>/ops/deploy.md`），会自动建目录；
  绝对路径或含 `..` 的 `doc_key` 会被跳过并打印 `跳过异常 doc_key: …`。
- `get` / `delete` / `rename` / `title` / `versions` / `version` / `snapshot` / `restore` 的
  `<doc>` 形参**既可以是数字 id，也可以是 doc_key 或文件名**：纯数字先按 id 查，
  查不到再当 doc_key；其余按 doc_key/filename 在 `list` 结果里匹配。找不到时报
  `ptdocctl: 未找到文档: <形参>`，退出码 1。
- `--user/--pass` 只是登录换 Cookie，仅在没给 `--token` 时生效；Cookie 只在单次进程内有效，
  每次运行都会重新登录。
- 所有输出都是**人类可读文本，没有 JSON 模式**。要结构化数据走 curl（见
  `references/api.md`）；解析 `list` 时按 TAB 切列。
- `push`/`pull` 默认**比内容再写**：远端与本地 sha256 一致就跳过（不产生写入）；不一致时
  不覆盖，列冲突清单后退出码 1。加 `--force` 才覆盖：`push --force` 先给远端打快照，
  `pull --force` 先把本地另存 `<file>.bak-<ts>`。
- `title` 走的是 upsert（服务端无单独改标题接口），所以会把**原文档全文原样回传**；正文
  不会变，但服务端会更新 `updated_at` 并可能触发一次自动快照。
- `restore` 回滚前服务端会自动把当前内容存成 manual 版本，回滚本身不丢内容。

## 已知限制

- 无 JSON 输出、无 `--dry-run`。版本历史/回滚已有 `versions` / `version` / `snapshot` /
  `restore` 四个命令；`push` 覆盖前也会自动比内容。
- 没有分享、媒体、归档、用户管理、扩展、空间管理的子命令，这些只能走 REST。
- `versions` 只取第一页（`limit=50`），更早的版本没有翻页入口（可用 curl 带 `cursor`）。
- `pull` 是全量，没有增量/单目录过滤；文档很多时输出很长。
- 没有并发控制，`pushr` 是串行；两个进程同时对同一 doc_key push 时后到的覆盖先到的。

## 常见错误

| 现象 | 原因 |
| --- | --- |
| `缺少 --token（或 --user 与 --pass）` | 没给认证参数；注意 `--user` 与 `--pass` 必须成对 |
| `登录失败(HTTP 401): {"error":"用户名或密码错误"}` | 密码错；连续 5 次会锁 15 分钟（HTTP 429） |
| `HTTP 401: {"error":"未登录"}` | Token 错、已被清空（`DELETE /api/auth/token`），或含非法字符（Token 只允许字母数字 16–64 位） |
| `ptdocctl: 未找到文档: xxx` | 形参既不是存在的 id，也不是任何 doc_key/filename |
| `push` 成功但标题是文件名 | md 里没有行首 `# ` 的 H1 |
| `pushr` 报 `目录下没有 .md 文件` | 目录里没有 `.md`（大小写不敏感匹配 `.MD`） |

## 与旧版 skill 说明的差异（校正）

外面流传的旧版说明写「`delete` 只吃 doc_id，不吃 doc_key」——**当前源码已不是这样**：
`delete` 会先把形参解析成 id（`ptdocctl/main.go` 的 `resolve`），传 doc_key 或文件名同样可用，
本轮已实测 `delete cli-test.md` 成功。以本文件为准。

## 空间（Space）

文档按空间隔离：`doc_key` 在**每个空间内**唯一，两个空间可以各有 `README.md`。

```bash
# 读：只列/只搜该空间
ptdocctl --url $PTDOC_URL --token $PTDOC_TOKEN --space 工作 list
ptdocctl --url $PTDOC_URL --token $PTDOC_TOKEN --space 3 search eBPF

# 写：落到该空间；不传 --space 则落默认空间（与旧行为一致）
ptdocctl --url $PTDOC_URL --token $PTDOC_TOKEN --space 工作 push README.md
```

- `--space` 接受空间名（忽略大小写）或 id
- 名字不存在时报错并列出可用空间，不会静默落到默认空间
- 目标空间已有同名文档 → 在**该空间内**原地更新
- 目标空间没有、但**别的空间**有这个 key → 服务端自动加 `~2` 后缀新建，CLI 会打印「服务端改写为 …」
- 不带 `--space` 的读命令仍是全空间（向后兼容）；`get/delete` 若 doc_key 跨空间重名会收到 409，需要带 `--space`
