# Space 隔离设计（v1.0）

> 2026-11-15 定稿。14 项决策来自与 yui 的逐条访谈，均已拍板。
> 现状盘点：space 已存在（spaces / space_folders / docs.space_id），但 `UNIQUE(user_id, doc_key)`
> 让「同名文档」跨空间静默覆盖（实测：空间 2 建 notes.md 会改写空间 1 那份，且不进空间 2）。
> 本轮把它做成真正的命名空间，并把 UI 补成「有 space 的」。

## 1. 产品形态（已拍板）

**Space = 全局工作区**：切空间换整个上下文 —— 侧栏树、新建文档、归档、搜索范围都跟着换。

**切换入口**：侧栏顶部下拉（替换现在挤成一排的 chips），含当前空间名、切换列表、「＋ 新建空间」。

**跟随范围**：
| 面 | 是否跟空间 | 形态 |
| --- | --- | --- |
| 侧栏文档树 | 是 | 只显示当前空间 |
| 新建 / 导入文档 | 是 | 落当前空间（可拖到其他空间） |
| 归档列表 | 是 | 空间下拉：当前空间 / 全部空间 / 具体空间；全部时**按空间分组** |
| 全文搜索 | 是 | 同上单选 + 全部空间 |
| 智能体问答检索 | **否** | 保持全库，避免问答搜不到其他空间的知识 |
| 媒体库图床 | **否** | 保持全局一份，避免同图重复上传 |

**筛选控件**：单选下拉。默认选中当前空间，可切「全部空间」或任意具体空间。
**后端要求**：所有列表/搜索 API 必须支持空间筛选参数，不能只在前端过滤。

**URL**：当前空间写进 query（`?space=<id>`），刷新与分享可恢复。

**切空间时**：有未保存改动才弹窗拦截；无改动直接切，并打开新空间首篇文档。

**默认空间**：可改名；默认标记可转给其他空间；恒有且仅有一个默认（不可删）。

**同名冲突**（跨空间搬移、ptdocctl push）：自动加后缀 `~2`、`~3`……并把最终 doc_key 回显给调用方。

**ptdocctl**：加 `--space <name|id>`；不传落默认空间（与现行为兼容）。

**doc_key 歧义**：API 只收到 doc_key 且跨空间命中多篇 → `409`，提示带 `?space=`。不静默选一个。

**存量文档**：不拆，全部留在当前默认空间。

## 2. Schema 变更

SQLite 不能删列级唯一约束，只能重建表。

| 对象 | 现状 | 改为 | 备注 |
| --- | --- | --- | --- |
| `docs` | `UNIQUE(user_id, doc_key)` | `UNIQUE(user_id, space_id, doc_key)` | 需重建表（`docs` → `docs_ns` → rename），保留 id 与所有列 |
| `idx_docs_archive_path` | `UNIQUE(user_id, archive_path)` | `UNIQUE(user_id, space_id, archive_path)` | 否则两空间同名文档归档路径互撞 |
| `ux_shares_active` | `UNIQUE(user_id, doc_key) WHERE status='active'` | 加 `space_id` 列后 `UNIQUE(user_id, space_id, doc_key) WHERE status='active'` | 存量按 doc_key 回填 space_id |
| `ux_docs_archive_token` | `UNIQUE(archive_token)` | 不变 | token 是随机串，全局唯一没问题 |

迁移顺序（`migrateSpaceNamespacing()`，幂等）：
1. `PRAGMA user_version` 标记，已迁移直接返回
2. 确保 `docs.space_id` 全部非空（沿用 `migrateSpaceSchema` 的回填）
3. 重建 docs 表（保留 id）
4. 重建 `idx_docs_archive_path`
5. `shares` 加 `space_id`，按 `docs.doc_key` 回填，重建 `ux_shares_active`
6. 写回 `user_version`

## 3. API 变更

**读接口**统一 `?space=<id>|all`：
- 缺省 `all`（向后兼容现有脚本与 skills/ptdoc 文档）
- 前端默认传当前空间 id

| 接口 | 变更 |
| --- | --- |
| `GET /api/docs` | 加 `space`，与 `q` 组合 |
| `GET /api/docs/full` | 加 `space` |
| `GET /api/docs/:id` | 数字 id 照旧；doc_key 形式新增 `space` 解析上下文，多命中 409 |
| `GET /api/archive` | 加 `space`；`include=all` 时返回分组用的 space 名 |
| `GET /api/spaces/:id/tree` | 不变（本身就是单空间） |

**写接口**：
- `POST /api/docs`：已有 `space_id`；未给则默认空间
- `PATCH /api/docs/:id`（move）：落位冲突时自动加 `~n` 后缀，响应回 `doc_key`
- `POST /api/spaces/:id/...`：不变
- `PATCH /api/spaces/:id`：新增可改 `is_default`（转移默认标记）

**解析层**：`resolveDocRef(userId, ref, spaceId?)`；`getDocByKey(userId, key, spaceId?)`。
不带 space 且跨空间多命中 → `HttpError(409, …)`。

## 4. UI 变更

1. **侧栏顶部空间下拉**（`sidebar.ts`）：替换 `#space-list` 的 chips 渲染
   - 收起态：`▣ 当前空间名 ▾`；展开：空间列表（含默认空间标记）、「＋ 新建空间」、改名/删除入口
2. **归档页头部**加空间下拉（`archive.ts` + `index.html`）：默认「当前空间」
   - 选「全部空间」→ 列表按空间分组渲染小节标题
3. **全文搜索框**加同一个空间下拉；搜索请求带 `space`
4. **文档页**：切空间时若有未保存改动 → 拦截；否则打开新空间首篇
5. **空间管理**：下拉里可改名、可「设为默认」、可删除（非默认；有内容时必须 `move_to`）

## 5. 分阶段实施

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P1** | schema 迁移 + db 层（upsert/create/move 冲突加后缀、resolveDocRef 带空间、各类 list 加空间过滤） | 单测：两空间同名文档可共存、互不覆盖；搬移撞名自动 `~2`；迁移幂等 |
| **P2** | API 读接口 `?space=`；写接口冲突回显；`PATCH /api/spaces/:id` 支持 `is_default` | 单测 + curl 实测跨空间搜索与筛选 |
| **P3** | 侧栏空间下拉 + 切空间行为（未保存拦截） | 浏览器实测：切空间树换、未保存拦截、刷新恢复 |
| **P4** | 归档页空间下拉 + 全部空间分组；搜索框空间筛选 | 浏览器实测：分组正确、筛选生效 |
| **P5** | ptdocctl `--space`；skills/ptdoc 文档同步 | Go 单测 + 真机 push 到指定空间、撞名回显 `~2` |

## 6. 风险

- **docs 表重建**：生产库需先备份（沿用 `docs-archive-migrate-backup` 机制）；迁移必须幂等且可断点续
- **doc_key 语义收窄**：任何按 doc_key 寻址的旧调用（ptdocctl、skills 里的 curl 示例）在不带 space 且命中多篇时会开始收到 409
- **归档路径冲突**：放宽到 `(user_id, space_id, archive_path)` 后，存量归档链接（`/a/<token>`）不受影响，但归档树可能同时出现两个同名路径
