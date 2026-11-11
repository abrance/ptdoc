# 暂存区 / 归档区 概念设计（草案 v0.1）

> 状态：**概念稿，未实现**。本轮不改 main 代码，不做数据迁移。
> 基线：`main` @ `cd3e563`（PR #36 未合），所有 `file:line` 按该树实测；`src/ui/styles.css` 的数值同时给出 PR #36 分支（`261111-ui-typography`）行号时会单独标注。
> 目标读者：拍板需求的作者本人 + 后续实现者。

---

## 0. 一句话结论

ptdoc 现在只有**一个区**：`docs.content` 这一份工作副本，外加一条"打上 `archive_path` + 取最近一次已发布分享"拼出来的归档视图。
用户口中的"暂存区 / 归档区"目前不是两套存储，而是**同一个文档的两种呈现**。要让概念站得住，必须把"归档"从**标记**升级成**不可变产物**。

现状体检（三条硬事实）：

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 全库只有一份正文 | `docs.content`，`upsertDoc` 每次整列覆盖写 `src/server/db.ts:669-693`、表定义 `src/server/db.ts:20-35` |
| 2 | 版本历史是手动快照，无自动、无去重、无上限 | `createSnapshot` `src/server/db.ts:811-817`；建表 `src/server/db.ts:380-386`；全仓无 TTL/裁剪逻辑 |
| 3 | 归档不是副本，是路径标记 + 最近一条分享 | `docs.archive_path` `src/server/db.ts:298`；归档条目由 `listArchive` 按 `doc_key` 取最新 share 拼出 `src/server/db.ts:1587-1660` |

---

## 1. 术语表

每个词一句定义 + 一句「它不是什么」。

| 术语 | 定义 | 它不是什么 |
| --- | --- | --- |
| **暂存区（Draft Zone）** | 正在编辑的文档集合，每篇文档以 `docs.content` 为唯一工作副本，可随时被覆盖写。 | 不是版本库：工作副本被覆盖后，旧内容只能靠快照找回。 |
| **工作副本（Working Copy）** | 某篇文档此刻在 `docs.content` 里的那份文本，编辑器直接读写它。 | 不是不可变对象：每次自动保存都会整体替换，没有 id、没有哈希、不可引用。 |
| **版本快照（Snapshot）** | 某一时刻对所有工作副本内容的一次不可变拷贝，落 `doc_versions`，带时间戳与可选标签。 | 不是归档：快照只服务"回滚"，不对外分享、不生成 md/html 产物、不进归档树。 |
| **自动快照（Auto Snapshot）** | 保存时由系统自动生成的快照，按内容哈希去重，受留存策略裁剪。 | 不是用户手动"保存快照"：手动快照带 label，永不被自动淘汰。 |
| **归档产物（Archive Artifact）** | 从某一版暂存内容生成的一对不可变文件：归档 `.md` + 归档 `.html`，各带稳定短链。 | 不是工作副本的视图：产物生成后内容固定，不随暂存区继续编辑而变化。 |
| **归档目录（Archive Folder）** | 归档树里的路径节点，如 `设计/架构/`，只组织产物位置，不承载内容。 | 不是磁盘目录：`archive_folders` 只是路径字符串，文件在七牛对象存储。 |
| **分享链接（Share Link）** | 指向**某一份具体归档产物**的稳定短链，永久有效。 | 不是"永远最新"链接：新归档不会让它指向新内容（需要另设别名链）。 |
| **发布站点（Published Site）** | `npm run build-site` 把 `docs` 表全量渲染成的自包含静态站，输出 `dist-site/`。 | 不是归档区：站点是全库快照式导出，不参与单篇归档/分享语义。 |
| **归档状态（Stale）** | 归档产物生成后暂存区又改过，`sha256(docs.content) != shares.source_content_sha256`，归档条目显示"有更新未归档"。 | 不是错误状态：只是提示可以重新归档，旧产物仍然可访问。 |

---

## 2. 两条生命周期状态机

### 2.1 一份文档的全路径（目标态）

```
                 ┌──────────────── 暂存区（Draft Zone）────────────────┐
                 │                                                   │
 [新建] ──▶ 工作副本(docs.content) ──编辑──▶ 工作副本(变脏)           │
                 │        ▲                     │                    │
                 │        │ restore             │ 800ms 防抖自动保存   │
                 │        │                     ▼                    │
                 │   版本快照(doc_versions) ◀── 自动快照(哈希去重)     │
                 │        │   ▲                  │                    │
                 │        │   └── 留存策略裁剪(10条/7天/至少1条)       │
                 └────────┼──────────────────────┼───────────────────┘
                          │ 手动"保存快照"        │ 点「归档」
                          │ (带 label, 永不裁剪)  ▼
                 ┌────────┴───────── 归档区（Archive Zone）────────────┐
                 │  归档产物 v1 (md + html, 不可变) ──▶ 稳定短链 /s/a/xx │
                 │        │                                            │
                 │        ├─ 再归档 ──▶ 新产物 v2（默认覆盖展示，旧产物下线）
                 │        └─ 删除 ──▶ 产物 + 链接一起失效               │
                 └─────────────────────────────────────────────────────┘
```

边界规则（三条，缺一条概念就塌）：

1. **写只发生在暂存区。** 归档产物是只读的，任何编辑都回到工作副本再重新归档。
2. **归档不移动、不锁定暂存区文档。** 归档后 `docs.doc_key` 不变、仍可继续编辑；只是产物与当前内容产生 `stale` 差异。
3. **删除产物 ≠ 删除文档。** 删归档产物只删产物与链接，工作副本与快照保留。

### 2.2 归档产物的状态机（目标态）

```
 [不存在] ──归档──▶ [已发布 active] ──再归档──▶ [已发布 active (v2)]
                        │                              │
                        │ 暂存区又编辑                  │ 旧 v1
                        ▼                              ▼
                   [已发布 + stale]              [已下线 superseded]
                        │                              │
                        └────────删除──────────────────┴──▶ [已删除, 链接 410]
```

### 2.3 现状状态机（对照用，说明缺口）

```
[新建] ─▶ docs.content ─(手动点"保存快照")─▶ doc_versions
              │
              └─(点"分享/生成分享版")─▶ shares 行(html_url 非空)
                                          │
                                          └─▶ ensureArchivePath 给 docs 打 archive_path
                                                │
                                                └─▶ listArchive 按 doc_key 取最新 share 显示
```

缺口：`shares` 表其实**已经存了多份历史分享**（`listShares` `src/server/db.ts:991-1010` 按时间倒序全量返回），只是 `listArchive` 主动只取最新一条（`src/server/db.ts:1603-1606` 的 `latest` Map），历史产物既看不见也没有淘汰策略。

---

## 3. 能力对照：现状 → 目标

| 能力 | 现状（实测 file:line） | 目标 |
| --- | --- | --- |
| 工作副本 | 单列 `docs.content`，覆盖写：`src/server/db.ts:20-35`、`src/server/db.ts:669-693` | 保留。仍是暂存区唯一真相。 |
| 自动保存 | 前端 800ms 防抖 `saveCurrentDoc`：`src/ui/app.ts:439-465` | 保留，另加"保存成功即触发自动快照"。 |
| 版本快照 | 手动：`createSnapshot` `src/server/db.ts:811-817`；列出 `819-825`；回滚 `827-837`；删除 `839-851` | 增加 `kind=auto/manual` + `content_sha256` 去重 + 留存策略裁剪。 |
| 快照 UI | 「快照」抽屉，含保存/预览/回滚/删除：`src/ui/app.ts:1398-1560`；入口按钮 `index.html:208` | 改成右侧常驻「版本历史」面板，自动/手动混排，带留存策略设置块。 |
| 归档语义 | `docs.archive_path` 路径标记 `src/server/db.ts:298`；`archive_folders` 路径树 `308-316`；唯一索引 `317` | 升级为独立 `archive_artifacts` 表（不可变产物），路径仍在归档树上。 |
| 归档列表 | `listArchive` 按 doc_key 取最新 share + `stale` 判定：`src/server/db.ts:1587-1660` | 按产物列表返回，默认只显示最新一份，`stale` 语义保留。 |
| 归档入口 | 侧栏底部折叠区 `index.html:129-143`，`src/ui/sidebar.ts:296-310`；无独立 Tab（`src/ui/app.ts:245` 注释） | 升级为顶层「暂存区 / 归档区」双 Tab，归档树独立成页。 |
| 分享生成 | 前端渲染 + 传七牛 + 落库：`src/ui/app.ts:780-820`；落库 `insertShare` `src/server/db.ts:916-947` | 归档动作统一走服务端，产物与 artifact 行同一事务。 |
| 分享链接 | 托管页 `GET /s/:id`：`src/server/api.ts:63-76`；`buildShareHtmlDoc` `src/core/share-html.ts:7` | 产物级稳定短链（不可变）+ 可选"永远最新"别名链。 |
| 分享删除 | `deleteShare` 只删 DB 行，七牛文件保留（代码注释自述）：`src/server/db.ts:975-989` | 删除产物需连带失效链接，并按配置决定是否删七牛对象。 |
| 归档路径校验 | 必须有已发布 share 才能改路径：`updateArchivePath` `src/server/db.ts:1682-1691` | 保留该校验，改为"必须有 active 产物"。 |
| 归档目录 | 建/改名：`src/server/db.ts:1692-1771`（`createArchiveFolder` 1692、`renameArchiveFolder` 1708）；API `src/server/api.ts:98-110` | 保留，补删除产物时的空目录回收。 |
| 静态站点发布 | `scripts/build-site.ts:1-5`，全量导出 `dist-site/` | 保留，不动。 |
| 媒体库 | `initMediaPanel` `src/ui/media.ts:35`；`media` 表 `src/server/db.ts:386-396` | 保留，归档产物 md/html 不入媒体库（沿用 `X-Source: share` 约定 `src/ui/app.ts:480-487`）。 |
| TOC / 互链 | `renderToc` `src/ui/toc.ts:15` | 保留，两种 Tab 下都要能用。 |
| 知识库同步 | `syncArchiveToQdrant` `src/server/archive-qdrant.ts`；`qdrant_sync` 三态 `src/server/db.ts:1645-1651` | 保留，改挂到 artifact id 上。 |

---

## 4. 默认口径（按此设计，除非有硬技术障碍）

1. **暂存区 = `docs.content` 工作副本 + 自动版本历史。**
   每次自动保存成功后，若有内容变化则写一条 `kind=auto` 快照；按 `content_sha256` 去重（连续相同内容不重复写）。
   留存策略参数化，放**用户设置**而非环境变量：`snapshotKeepCount`=10、`snapshotKeepDays`=7、`snapshotKeepMin`=1。
   裁剪顺序：先按天数淘汰，再按条数淘汰，最后强制保留最近 `min` 条（手动快照不参与淘汰）。
2. **归档 = 从暂存区内容产生不可变产物（md + html），落在归档树路径下，并生成分享链接。**
   归档**不移动、不锁定**暂存区文档；归档后仍可继续编辑。
3. **归档产物默认只保留最新 1 份**（用户明确"暂时只想要最后被归档的版本"），
   但**数据模型按多版本设计**，用配置项 `archiveKeepVersions` 控制，默认 `1`，以后能改成 `N`。
4. **分享链接语义**：每条归档产物有稳定短链，指向该产物，永久有效。
   将来留多版本时，另给"永远指向最新"的别名链（`/s/latest/<doc_key>`）。
   删产物必须连带让链接失效（410），不能留活链接指向已删产物。
5. **归档产物与暂存区的关系是"来源"，不是"副本同步"。**
   产物记录 `source_content_sha256`，暂存区变更只产生 `stale` 提示，不自动重归档。

---

## 5. 数据模型迁移草案

### 5.1 新增 `archive_artifacts`

```sql
CREATE TABLE IF NOT EXISTS archive_artifacts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL,
  doc_id               INTEGER NOT NULL REFERENCES docs(id),
  doc_key              TEXT    NOT NULL,
  version              INTEGER NOT NULL,          -- 该文档第几次归档，从 1 递增
  archive_path         TEXT    NOT NULL,          -- 归档树路径，如 设计/架构/ptdoc.md
  md_url               TEXT    NOT NULL,          -- 七牛 .md 永久链接
  html_url             TEXT    NOT NULL,          -- 七牛 .html 永久链接
  slug                 TEXT    NOT NULL,          -- 稳定短链 slug，全局唯一
  source_content_sha256 TEXT   NOT NULL,          -- 生成时的暂存内容哈希
  size_md              INTEGER NOT NULL DEFAULT 0,
  size_html            INTEGER NOT NULL DEFAULT 0,
  status               TEXT    NOT NULL DEFAULT 'active', -- active | superseded | deleted
  created_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_slug
  ON archive_artifacts(slug) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_artifact_doc
  ON archive_artifacts(user_id, doc_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_version
  ON archive_artifacts(doc_id, version);
-- 默认只保留 1 份时，"同一路径只有一条 active"
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_active_path
  ON archive_artifacts(user_id, archive_path) WHERE status = 'active';
```

### 5.2 扩展 `doc_versions`

```sql
ALTER TABLE doc_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';   -- auto | manual
ALTER TABLE doc_versions ADD COLUMN content_sha256 TEXT;
ALTER TABLE doc_versions ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_versions_sha ON doc_versions(doc_id, content_sha256);
```

兼容存量（**重要**）：

- 存量 `doc_versions` 行一律视为 `kind='manual'`（默认值即此），`label` 语义完全保留：手动快照永不被留存策略裁剪。
- 存量 `content_sha256` 回填用一次性迁移脚本算（`sha256(content)`），失败则留 `NULL`，去重逻辑对 `NULL` 行退化为"不比较"。
- `docs.archive_path` **不删**，作为"该文档当前归档位置"的冗余快照（rename 归档目录时少一次 join）；
  但"是否存在归档"的判定改为查 `archive_artifacts`，不再依赖 `hasPublishedShare`。
- 存量 `shares` **不迁移、不删除**：历史分享仍可通过 `/s/:id` 访问。
  迁移时可为每个 `doc_key` 的最新一条 `shares` 生成一条 `archive_artifacts`（`version=1`，`slug='s'+share.id`），保证升级后归档区不空。
- 回滚方案：迁移只做 `ADD COLUMN` / `CREATE TABLE`，旧代码读不到新列也能跑；`archive_artifacts` 可整体 drop 而不影响暂存区。

---

## 6. API 草案

| 方法 | 路径 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/docs/:id/versions` | `?limit&cursor` | `{items:[{id,kind,label,size,content_sha256,created_at}]}` | 分页列版本历史，不返回 content（大文本懒加载） |
| GET | `/api/docs/:id/versions/:vid` | — | `{id,content,...}` | 预览单条版本内容 |
| POST | `/api/docs/:id/versions` | `{label?}` | `{id}` | 手动快照（等价现 `createSnapshot`） |
| POST | `/api/docs/:id/versions/:vid/restore` | — | `{ok}` | 回滚，回滚前自动存一条 manual |
| DELETE | `/api/docs/:id/versions/:vid` | — | `{ok}` | 只允许删 manual；auto 只能等淘汰 |
| GET | `/api/settings/retention` | — | `{snapshotKeepCount,snapshotKeepDays,snapshotKeepMin,archiveKeepVersions}` | 用户级留存策略 |
| PUT | `/api/settings/retention` | 同字段，带范围校验 | `{ok}` | 参数落 `user_settings` |
| POST | `/api/docs/:id/archive` | `{archive_path?, note?}` | `{artifact_id,version,slug,md_url,html_url}` | 服务端生成 md+html、上传、落 artifact 行（一个事务） |
| GET | `/api/archive` | `?q` | `{entries:[...],folders:[...]}` | 保留现结构，`entries` 改由 artifact 驱动，默认 `status=active` |
| GET | `/api/archive/:artifactId` | — | `{artifact,doc}` | 产物详情 |
| POST | `/api/archive/:artifactId/republish` | `{keep_versions?}` | `{artifact_id,version}` | 重新归档（默认把旧产物置 superseded） |
| DELETE | `/api/archive/:artifactId` | `?purge=1` | `{ok}` | `status='deleted'`；`purge=1` 才删七牛对象 |
| GET | `/s/a/:slug` | — | HTML | 产物直链，`deleted` 返回 410 |
| GET | `/s/latest/:docKey` | — | 302 | 别名链，指向当前 active 产物（可选能力） |
| GET | `/api/archive/folders` 等 | 沿用 `src/server/api.ts:98-110` | 沿用 | 不改 |

兼容策略：现有 `/api/docs/:id/snapshots` 系列保留为别名，内部转发到 versions（避免一次性改前端）。

---

## 7. UI 触点

### 7.1 全局：双 Tab

顶部主导航从「文档 / 智能体 / 分享 / 设置」(`src/ui/app.ts:233`) 改为 **文档页内部**双 Tab：`暂存区` / `归档区`。
侧栏随 Tab 切换内容：暂存区显示文档树，归档区显示归档树（沿用 `SidebarMode` `src/ui/sidebar.ts:31`，不再藏在折叠区）。
状态持久化：沿用 localStorage 记忆（参考 `src/ui/sidebar.ts:296-310` 的 `ptdoc.sider-archive-open` 做法，key 改为 `ptdoc.zone`）。

### 7.2 暂存区

- **文档树**：保持现状（搜索、文件夹、重命名、删除）。
- **编辑器 / 预览**：保持现状（实时渲染、TOC、Mermaid）。
- **右侧「版本历史」面板**（替换现在的抽屉 `src/ui/app.ts:1398-1440`）：
  - 竖向时间线，每条显示：时间（相对 + 绝对 tooltip）、大小、`自动` / `手动` 徽标、内容哈希前 7 位。
  - 悬停出两个动作：`预览`（右侧分栏 diff 或纯预览）、`回滚`（二次确认）。
  - 自动快照只读，只有手动快照有删除按钮（删除按钮在 hover 时出现）。
  - 顶部一行筛选：`全部 / 自动 / 手动`。
- **留存策略块**（面板底部，可折叠）：
  - 三个数字输入：`保留最近 [10] 条`、`清理超过 [7] 天`、`至少保留 [1] 条`。
  - 一行灰字实时说明："当前 23 条，按此策略将清理 8 条（预计释放 1.2 MB）"。
  - 保存后立即执行一次裁剪，并 toast 告知清理条数。

### 7.3 归档区

- **归档树**：左侧，沿用现路径树；空态文案改为"还没有归档产物"。
- **产物卡片列表**：右侧主区，每张卡：
  - 标题 + 归档路径面包屑；
  - 归档时间、版本号 `v3`、产物大小（md / html 分别）；
  - 两个入口按钮：`查看 MD`、`打开 HTML`（新标签）；
  - `复制链接`：复制稳定短链 `/s/a/<slug>`，复制后按钮变"已复制"2 秒；
  - `stale` 提示条：暂存区已更新时显示"暂存区有更新，重新归档会覆盖当前产物"；
  - 更多菜单：`重新归档`、`移动到…`、`删除产物`。
- **重新归档确认框**：明确写"将生成 v4 并下线 v3，短链 `/s/a/xx` 失效，`/s/latest/xx` 指向 v4"。
- **空态**：一张带箭头的引导卡，指向暂存区的「归档」按钮。

---

## 8. 回归清单（不许丢）

| # | 能力 | 验证点 | 现状锚点 |
| --- | --- | --- | --- |
| 1 | 手动快照 | 保存快照 → 列表出现 → 预览内容一致 → 回滚后 `docs.content` 等于快照 → 回滚前自动存一条 | `src/server/db.ts:811-837` |
| 2 | 快照删除 | 删 manual 后列表消失，删 auto 被拒绝 | `src/server/db.ts:839-851` |
| 3 | 自动保存 | 停止输入 800ms 后状态栏 `已保存` | `src/ui/app.ts:461-465` |
| 4 | 分享生成 | 点分享 → md/html 上传七牛 → 落库 → 弹窗可复制链接 | `src/ui/app.ts:780-820` |
| 5 | 托管页 | `GET /s/:id` 返回渲染后的 HTML，未知 id 404 | `src/server/api.ts:63-76` |
| 6 | 静态站发布 | `npm run build-site` 产出 `dist-site/`，文档数与 `docs` 一致 | `scripts/build-site.ts:1-5` |
| 7 | 媒体库 | 上传图片落 `media` 表，删除走 BucketManager，分享产物不入库 | `src/ui/media.ts:35`、`src/ui/app.ts:480-487` |
| 8 | TOC | 预览区目录生成、滚动高亮、点击跳转 | `src/ui/toc.ts:15` |
| 9 | 互链 | 站内 `[[doc]]` 跳转不断链；改 doc_key 后旧链接按预期失效 | `src/server/db.ts:743` rename 级联 |
| 10 | 归档路径唯一 | 同一路径不能两篇文档；改名不冲突 | `src/server/db.ts:317`、`1708-1771` |
| 11 | 归档树折叠状态 | 刷新后保持展开/折叠 | `src/ui/sidebar.ts:296-310` |
| 12 | 知识库同步三态 | `none/synced/stale` 徽标正确 | `src/server/db.ts:1645-1651` |
| 13 | 存量数据 | 升级后旧手动快照仍在、旧 `/s/:id` 仍可访问、归档区不为空 | 5.2 节迁移 |

---

## 9. 开放决策（需用户拍板）

### D1. 归档是否保留多版本？

- **选项 A**：只留最新 1 份，旧产物置 `superseded` 并从列表隐藏（数据仍在，可回溯）。
- **选项 B**：列表显示全部历史产物，可逐条删。
- **推荐 A**。理由：用户明确"暂时只想要最后被归档的版本"；数据模型已支持多版本，配置 `archiveKeepVersions=1`，改 B 只需改展示层。
- **代价**：A 之下旧链接会随重新归档失效（若选了 D2 的永久短链，则旧短链 410，需接受）。

### D2. 稳定短链指向"这一份产物"还是"永远最新"？

- **选项 A**：`/s/a/<slug>` 指向具体产物（不可变），另给 `/s/latest/<docKey>` 别名指向最新。
- **选项 B**：只维护一条"永远最新"链接，重新归档后自动指向新版本。
- **推荐 A + 额外提供 B**。分享出去的材料不应该悄悄变内容；但日常"给对方一个总入口"确实需要 B。
- **代价**：两套链接语义，UI 上要明确区分"复制产物链接"与"复制最新链接"，否则用户会混淆。

### D3. 自动快照的触发时机？

- **选项 A**：每次自动保存成功后（800ms 防抖落库）判断内容变化，变了就写一条 auto 快照。
- **选项 B**：定时（如每 5 分钟）扫一次有变更的文档。
- **选项 C**：只在页面隐藏 / 切换文档时写。
- **推荐 A**。理由：与现有保存路径同源，不引入新定时器；哈希去重保证不会因反复自动保存而膨胀。
- **代价**：长文连续编辑会产生较多快照，靠留存策略（10 条 / 7 天）兜住；若用户觉得太密，可加"最小间隔 N 秒"参数。

### D4. 归档产物的 md/html 由谁生成？

- **选项 A**：服务端生成（复用 `buildShareHtmlDoc` + `renderMarkdown`），与落库同一事务，前端只发起一次请求。
- **选项 B**：沿用前端生成 + 上传 + 落库三段式（现状 `src/ui/app.ts:780-820`）。
- **推荐 A**。理由：归档是"产物"，产物生成必须可重放、可测试、不依赖浏览器在线；且能保证 DB 行与对象存储一致。
- **代价**：服务端要接七牛上传（已有 `qiniu-uploader.ts`），请求耗时从 ~1s 变长，需要进度反馈。

### D5. 删除产物是否删七牛对象？

- **选项 A**：只置 `deleted`，对象保留（安全，可手工恢复，占存储）。
- **选项 B**：默认删对象，`?purge=0` 可保留。
- **推荐 A 为默认，提供手动"彻底删除"**。理由：现状 `deleteShare` 已经有意不删七牛文件（`src/server/db.ts:975-989` 注释），沿用心智模型。
- **代价**：存储会缓慢增长，需要在媒体库/设置里给出占用统计。

### D6. 存量 `shares` 与新 `archive_artifacts` 的关系？

- **选项 A**：新表独立，老 `shares` 冻结只读，仅为兼容 `/s/:id`。
- **选项 B**：`shares` 加列并入新表，最终只留一套。
- **推荐 A**（本轮），迁移动静最小；等新流程稳定后再考虑 B 的合并。
- **代价**：短期两套数据并存，`listArchive` 需要"新表优先、老表兜底"的兼容分支。

---

## 附录：本轮同步修正的文案错误

PR #36 描述与 `ui-study-folio.md` §1 曾写"h1 无字号规则，实测落到 15px，比 h2 的 22.5px 还小，层级倒挂"。该说法不成立：

- `main` 的 `.markdown-body` 基准字号 15px（`src/ui/styles.css:1565-1571`），`.markdown-body h1` 只有 `border-bottom` 与 `padding-bottom`，**无 `font-size`**（`src/ui/styles.css:1579-1582`）→ 浏览器 UA 默认 `2em` = **30px**。
- `.markdown-body h2` 在 main 上**完全没有规则** → UA 默认 `1.5em` = **22.5px**。
- 所以 main 的真实层级是 h1 30px > h2 22.5px，**没有倒挂**；PR #36 的真实变化是 **h1 30px → 26px**（并补分隔线与下内距），h2 22.5px → 20px。

> 注：本附录只更正文字，不改任何实现代码。
