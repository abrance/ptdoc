# ptdocctl 命令行客户端

`ptdocctl/` 是本仓库自带的客户端（纯 Go 标准库，零依赖），适合脚本 / CI / 智能体做
批量拉取和推送。它调用的是 `references/api.md` 里那套 REST 接口——**同一套接口的两种
外壳**，行为差异只在输出格式上，不要按两套事实理解。

- 源码：`ptdocctl/main.go`（单文件，`go build` 即得）
- 最新发布：GitHub Releases 上的 `v1.4.x` 系列，制品名
  `ptdocctl-v<tag>-<os>-<arch>.tar.gz`（另附 `SHA256SUMS`）
- 本仓库**不存放二进制**：需要就用下面的安装方式取，别把 tar 包提交进仓库

## 安装

```bash
# 方式一：从 Releases 下载（Linux amd64 示例；macOS/arm64/windows 换对应制品名）
curl -fsSLO https://github.com/abrance/ptdoc/releases/latest/download/ptdocctl-v1.4.5-linux-amd64.tar.gz
tar xzf ptdocctl-v1.4.5-linux-amd64.tar.gz && sudo install -m755 ptdocctl-v1.4.5-linux-amd64 /usr/local/bin/ptdocctl

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
| `list` | 列出全部文档 | `GET /api/docs` | `id<TAB>doc_key<TAB>标题` |
| `get <doc_id\|doc_key>` | 打印全文 | `GET /api/docs` 定位，再 `GET /api/docs/<id>` | 正文原文（无行号、无装饰） |
| `search <keyword>` | 搜标题/正文 | `GET /api/docs?q=` | `id<TAB>doc_key<TAB>标题` |
| `pull [dir]` | 全量拉取 | `GET /api/docs/full` | `已写入 <path>` / `共拉取 N 个文档 → <dir>` |
| `push <file>...` | 上传，doc_key=文件名 | 每个文件 `POST /api/docs` | `已上传 <file> → <doc_key>` |
| `pushr <dir>` | 递归上传，doc_key 含子目录 | 同上，串行 | 每行 `已上传 …` + `共上传 N 个文件` |
| `delete <doc_id\|doc_key>` | 删文档 | 先定位，再 `DELETE /api/docs/<id>` | `已删除 <id><TAB><doc_key>` |

实测（本轮在独立实例上跑过，v1.4.5 源码构建 + 发布版二进制行为一致）：

```
$ pt docctl whoami
user=verifier id=1 role=admin server=http://127.0.0.1:5199

$ ptdocctl … pushr ./docs
已上传 /tmp/ptdoc-cli/docs/cli-test.md → cli-test.md
共上传 1 个文件

$ ptdocctl … list
2	cli-test.md	CLI 上传测试

$ ptdocctl … pull /tmp/pulled
已写入 /tmp/pulled/cli-test.md
共拉取 1 个文档 → /tmp/pulled

$ ptdocctl … delete cli-test.md
已删除 2	cli-test.md
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
- `get` / `delete` 的形参**既可以是数字 id，也可以是 doc_key 或文件名**：纯数字先按 id 查，
  查不到再当 doc_key；其余按 doc_key/filename 在 `list` 结果里匹配。找不到时报
  `ptdocctl: 未找到文档: <形参>`，退出码 1。
- `--user/--pass` 只是登录换 Cookie，仅在没给 `--token` 时生效；Cookie 只在单次进程内有效，
  每次运行都会重新登录。
- 所有输出都是**人类可读文本，没有 JSON 模式**。要结构化数据走 curl（见
  `references/api.md`）；解析 `list` 时按 TAB 切列。

## 已知限制

- 无 JSON 输出、无 `--dry-run`、无版本历史/回滚。`push` 覆盖即最终态——重要文档改动前先
  `pull` 存副本（服务端快照接口只能走 REST：`POST /api/docs/<id>/snapshots`）。
- 没有分享、媒体、归档、用户管理、扩展管理的子命令，这些只能走 REST。
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
