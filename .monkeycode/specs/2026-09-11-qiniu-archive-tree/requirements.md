# Requirements Document

## Introduction

PTDoc 工作区侧栏按 `doc_key` 路径展示全部草稿。分享记录目前是扁平列表（「分享记录」抽屉），生成分享版成功后会把 HTML / Markdown 上传到当前用户的七牛桶，但上传成功并不改变文档的组织方式。

本需求把「已上传到七牛的分享成品」视为 **Archive Entry（归档条目）**，并提供一棵可自由改路径的 **Archive Tree（归档目录树）**，方便按主题/项目浏览已发布文档。归档路径与工作区 `doc_key` 解耦：改归档目录不影响编辑中的草稿路径。

已确认约定：

- 归档判定：同一用户下，某 `doc_key` 至少有一条 `html_url` 非空的 Share。
- 树的粒度：每个 `doc_key` 在归档树中至多一个节点，指向该文档最新一条带 `html_url` 的 Share。
- 工作区树：归档后草稿仍留在左侧工作区树。
- 点击归档节点：打开七牛 HTML；同时提供「在编辑器打开」原稿。

## Glossary

- **System**：PTDoc 多用户工作区。
- **Current User**：持有有效 Session 的登录用户。
- **Workspace Document**：Current User 工作区内的一篇 Markdown 草稿，由 `docs` 标识，路径字段为 `doc_key`。
- **Share**：一次「生成分享版」的记录，可包含 `md_url`、`html_url`。
- **Qiniu HTML**：Share 的 `html_url` 指向的、已上传到 Current User 七牛桶的自包含 HTML。
- **Archive Entry**：满足归档条件的 Workspace Document 在归档视图中的对应节点。
- **Archive Path**：Archive Entry 在归档树中的逻辑路径（例如 `项目/2026/架构设计`），仅用于归档浏览与组织。
- **Archive Tree**：按 Archive Path 的 `/` 分段渲染的可折叠目录树。
- **Working Tree**：现有侧栏文档树，按 `doc_key` 渲染。
- **Latest Published Share**：同一 `doc_key` 下 `html_url` 非空的 Share，按 `created_at` 降序、`id` 降序取第一条。
- **Path Prefix Conflict**：两条路径相等，或其中一条以另一条加 `/` 为前缀（按 `/` 分段，同一节点不能既是文档又是文件夹）。
- **Archive Folder**：归档树中的文件夹节点，来源是 Explicit Archive Folder 或 Archive Path 的路径前缀。
- **Explicit Archive Folder**：用户新建的归档文件夹，即使没有子文档也要显示，并单独落库。
- **Default Archive Path**：等于该 Workspace Document 的 `doc_key`（保留 `.md` 分段，与 Working Tree 同一套路径结构）。
- **Published Content Hash**：生成分享版并写入 `html_url` 时，对当时 Workspace Document 的 `content` 做 SHA-256 得到的值，存在该 Share 上。
- **Stale Archive Entry**：Latest Published Share 带有 Published Content Hash，且当前 Workspace Document 的 `content` 的 SHA-256 与该 Hash 不同。

## Requirements

### Requirement 1: 归档资格

**User Story:** AS 作者, I want 把已经上传到七牛的分享成品自动算作归档, so that 我不用再手工挑哪些文档进归档。

#### Acceptance Criteria

1. WHEN Current User 对一篇 Workspace Document 生成分享版并且该 Share 的 `html_url` 写入成功, THE System SHALL 把该 Workspace Document 作为 Archive Entry 纳入 Archive Tree。
2. WHEN 一篇 Workspace Document 存在至少一条 `html_url` 非空的 Share, THE System SHALL 将这篇 Workspace Document 视为已归档。
3. WHEN Current User 仅向媒体库上传图片, THE System SHALL 保持各 Workspace Document 的归档资格不变。
4. WHEN 一篇 Workspace Document 在 Current User 名下不再拥有任何 `html_url` 非空的 Share, THE System SHALL 从 Archive Tree 移除对应 Archive Entry，并保留已有 `archive_path` 供再次归档时复用。
5. WHILE Current User 浏览 Archive Tree, THE System SHALL 仅展示属于该 Current User 的 Archive Entry 与 Archive Folder。
6. WHEN 一条 Share 的 `doc_key` 为空，或 Current User 名下不存在对应 Workspace Document, THE System SHALL 不把该 Share 渲染为 Archive Entry。
7. WHEN Current User 只生成了本地托管页 `/s/:id` 且该 Share 的 `html_url` 仍为空, THE System SHALL 不把对应 Workspace Document 视为已归档。

### Requirement 2: 归档目录树浏览

**User Story:** AS 作者, I want 用可折叠目录树查看已归档文档, so that 我能按文件夹快速找到已发布内容。

#### Acceptance Criteria

1. WHEN Current User 打开归档视图, THE System SHALL 按 Archive Path 的 `/` 分段渲染可折叠 Archive Tree。
2. WHEN 某 Archive Entry 尚无用户指定的 Archive Path, THE System SHALL 使用 Default Archive Path（即 `doc_key`）作为初始 Archive Path。
3. WHEN Current User 在归档视图的过滤框输入关键字, THE System SHALL 显示标题、Archive Path 或 Explicit Archive Folder 路径包含该关键字（不区分大小写）的节点，并保留这些节点的祖先文件夹。
4. WHILE Archive Tree 中某文件夹处于展开状态, THE System SHALL 显示该文件夹的直接子文件夹与直接 Archive Entry。
5. WHEN 两篇 Archive Entry 的 Archive Path 共享同一前缀, THE System SHALL 将共享前缀渲染为同一文件夹节点。
6. WHEN Current User 打开归档视图且没有任何 Archive Entry 也没有任何 Explicit Archive Folder, THE System SHALL 显示空态文案「还没有归档。生成分享版并上传 HTML 后会出现在这里。」
7. WHEN Current User 渲染 Archive Tree, THE System SHALL 在同一层级先按文件夹名称升序、再按文档标题升序排列。
8. WHEN Current User 刷新页面后再次打开归档视图, THE System SHALL 把文件夹折叠状态恢复为全部展开（折叠状态不持久化）。
9. WHEN 自动分配的 Archive Path 与同一用户下已有 Archive Path 或 Explicit Archive Folder 发生 Path Prefix Conflict, THE System SHALL 改用 `doc_key` + `~` + 文档 `id`；列表回填遇到冲突时使用同一规则，避免列表接口失败。

### Requirement 3: 自由组织归档路径

**User Story:** AS 作者, I want 随便改归档文档的目录位置, so that 发布后的分类可以和工作区草稿路径不一样。

#### Acceptance Criteria

1. WHEN Current User 将 Archive Entry 改到新的 Archive Path, THE System SHALL 持久化新的 Archive Path，并保持对应 Workspace Document 的 `doc_key` 不变。
2. WHEN Current User 将 Archive Entry 改到新的 Archive Path, THE System SHALL 保持 Latest Published Share 的 `html_url` 与七牛对象 key 不变。
3. WHEN Current User 把多个 Archive Entry 放到同一 Archive Path 前缀下, THE System SHALL 在 Archive Tree 中把这些 Archive Entry 显示为该文件夹的子节点。
4. WHEN Current User 提交的 Archive Path 与同一用户下另一篇 Archive Entry 冲突, THE System SHALL 拒绝这次改路径并返回可展示的错误说明。
5. WHEN Current User 重命名 Working Tree 中的 `doc_key`, THE System SHALL 保持已有 Archive Path 不变。
6. WHEN Current User 提交 Archive Path 或文件夹路径, THE System SHALL 在去掉首尾 `/` 与空白后接受长度 1 到 256 的路径；分段必须非空，禁止 `.` 与 `..`，禁止 ASCII 控制字符；其余字符（含括号、冒号、顿号）一律允许。
7. WHEN 提交的路径与同一用户下已有 Archive Path 或 Explicit Archive Folder 发生 Path Prefix Conflict, THE System SHALL 拒绝这次改路径并说明「同一路径不能既是文档又是文件夹」。
8. WHEN Current User 将 Archive Entry 改到新的 Archive Path, THE System SHALL 在 Archive Tree 中立即按新路径显示该条目。
9. WHEN 改路径失败, THE System SHALL 保持原 Archive Path 与原树结构不变。

### Requirement 4: 打开归档文档

**User Story:** AS 作者, I want 从归档树打开已发布页或回到原稿, so that 我既能给别人看成品，也能继续改草稿。

#### Acceptance Criteria

1. WHEN Current User 点击 Archive Entry 的主操作, THE System SHALL 打开该文档 Latest Published Share 的 Qiniu HTML。
2. WHEN Current User 选择「在编辑器打开」, THE System SHALL 在工作区加载对应 Workspace Document 的当前草稿。
3. IF Latest Published Share 的 `html_url` 无法打开, THE System SHALL 展示失败说明，并仍提供「在编辑器打开」。
4. WHEN Current User 点击 Archive Entry 的主操作, THE System SHALL 在新的浏览器标签页打开 Qiniu HTML（与现有「分享记录 → HTML」相同）。
5. WHEN Current User 选择「复制链接」, THE System SHALL 把 Latest Published Share 的 `html_url` 写入剪贴板。
6. WHEN Current User 从归档树「在编辑器打开」一篇文档, THE System SHALL 切回草稿 Tab 并在 Working Tree 中高亮该 Workspace Document。

### Requirement 5: 与分享记录共存

**User Story:** AS 作者, I want 归档树和现有分享记录一起用, so that 历史分享次数仍然可查。

#### Acceptance Criteria

1. WHILE 一篇 Workspace Document 有多次带 `html_url` 的 Share, THE System SHALL 在 Archive Tree 中只为该 Workspace Document 显示一个 Archive Entry，并绑定 Latest Published Share。
2. WHEN Current User 再次生成分享版且新 Share 写入 `html_url`, THE System SHALL 把该 Archive Entry 绑定到新的 Latest Published Share，并保持既有 Archive Path。
3. WHEN Current User 打开现有「分享记录」抽屉, THE System SHALL 继续按时间列出全部 Share。
4. WHEN Current User 在「分享记录」中删除 Latest Published Share、且该文档仍有更早的 `html_url` 非空 Share, THE System SHALL 把 Archive Entry 改绑到新的 Latest Published Share，并保持 Archive Path。
5. WHEN Current User 在「分享记录」中删除某条 Share, THE System SHALL 保持七牛上已上传对象不变（与现有删除分享行为一致）。

### Requirement 6: 工作区树与归档树并列

**User Story:** AS 作者, I want 草稿树和归档树分开, so that 我还在写的稿和工作已经发布的成品不会混在一个目录里改路径。

#### Acceptance Criteria

1. WHILE Current User 使用工作区, THE System SHALL 继续按 `doc_key` 展示 Working Tree，其中包含已归档与未归档的 Workspace Document。
2. WHEN Current User 切换到归档视图, THE System SHALL 展示该用户的 Archive Entry 与 Archive Folder。
3. WHEN Current User 删除一篇 Workspace Document, THE System SHALL 同时移除对应 Archive Entry（分享记录的级联删除规则与现有删除文档行为一致）。
4. WHEN Current User 处于归档视图, THE System SHALL 隐藏「新建文档」与「导入文件夹」。
5. WHEN Current User 在窄屏（宽度 ≤ 860px）打开归档视图, THE System SHALL 仍使用现有侧栏抽屉，不另开一层抽屉。
6. WHEN 首次列出归档且某条已归档文档的 `archive_path` 为空, THE System SHALL 按 Default Archive Path 规则回填后再展示。

### Requirement 7: 归档节点展示信息

**User Story:** AS 作者, I want 在树上看清标题和发布时间, so that 我能分辨哪篇是刚发布的成品。

#### Acceptance Criteria

1. WHEN System 渲染 Archive Entry, THE System SHALL 显示 Workspace Document 的 `title`；`title` 为空时显示 Archive Path 的最后一段。
2. WHEN Current User 把指针悬停在 Archive Entry 上, THE System SHALL 在 tooltip 中显示完整 Archive Path 与 Latest Published Share 的本地时间。
3. WHEN Current User 使用键盘在归档树中按 Tab 与 Enter, THE System SHALL 让焦点落到文档节点，Enter 触发与点击主操作相同的打开 Qiniu HTML。
4. WHEN Archive Entry 为 Stale Archive Entry, THE System SHALL 在该节点显示「有未发布改动」。
5. WHEN Latest Published Share 没有 Published Content Hash, THE System SHALL 不把该 Archive Entry 标为 Stale Archive Entry。
6. WHILE Current User 查看 Working Tree, THE System SHALL 不为已归档文档增加额外状态标记。

### Requirement 8: 失败与权限

**User Story:** AS 作者, I want 改路径或打开失败时看到明确原因, so that 我知道下一步做什么。

#### Acceptance Criteria

1. IF 提交的 Archive Path 与已有条目冲突, THE System SHALL 返回可展示文案「归档路径已被占用」。
2. IF 提交的 Archive Path 格式不合法, THE System SHALL 返回可展示文案并说明允许的字符与分段规则。
3. IF Current User 对尚未归档的文档请求改 Archive Path, THE System SHALL 返回可展示文案「文档尚未归档」。
4. IF 目标文档不属于 Current User, THE System SHALL 返回 404 且不泄露该文档是否存在于其他用户工作区。
5. IF 归档列表请求失败, THE System SHALL 在树区域显示「加载失败」。

### Requirement 9: 归档文件夹

**User Story:** AS 作者, I want 先建文件夹再往里放归档文档，也能整夹改名, so that 我可以按项目随意搭目录。

#### Acceptance Criteria

1. WHEN Current User 在归档视图新建文件夹并提交合法路径, THE System SHALL 创建 Explicit Archive Folder，即使该路径下还没有 Archive Entry 也要显示。
2. WHEN Current User 重命名或移动归档树中的任意文件夹节点（含仅由路径前缀派生的隐式文件夹）, THE System SHALL 把所有以 `from/` 开头的 Archive Path 与 Explicit Archive Folder 路径的该前缀替换为 `to/`，并把路径恰好为 `from` 的 Explicit Archive Folder 改为 `to`。
3. WHEN Current User 重命名或移动归档文件夹, THE System SHALL 保持涉及文档的 `doc_key`、`html_url` 与七牛对象不变。
4. WHEN 目标路径与已有 Archive Path 或已有 Explicit Archive Folder 冲突，或会造成「同一路径既是文档又是文件夹」, THE System SHALL 拒绝这次文件夹改名并保持原树不变。
5. WHEN Current User 删除一个 Explicit Archive Folder 且该路径下没有 Archive Entry, THE System SHALL 删除该文件夹及其所有后代空的 Explicit Archive Folder。
6. IF 待删除文件夹路径下仍有 Archive Entry, THE System SHALL 拒绝删除并说明「文件夹内还有归档文档」。
7. WHEN Archive Tree 渲染, THE System SHALL 把 Explicit Archive Folder 与 Archive Path 派生出的前缀合并为同一棵树。

## Out of Scope

- 媒体库图片的目录树。
- 改 Archive Path 时重命名或移动七牛上的对象。
- 多人共享同一棵归档树。
- 把仅有本地托管页 `/s/:id`、没有 `html_url` 的 Share 算作归档。
- 在归档树里直接编辑 Markdown 正文。
- 拖拽移动节点。
- 为过期的私有桶签名 URL 重新签名（打开方式与现有「分享记录 → HTML」相同，使用已存的 `html_url`）。
- 批量多选移动。
- 在 Working Tree 上标记已归档。

## Confirmed Decisions

1. 归档后 Working Tree 继续显示该文档。
2. 点击归档节点默认打开七牛 HTML；另提供「在编辑器打开」。
3. 归档树中每个 `doc_key` 一个节点，绑定 Latest Published Share；历史次数仍在「分享记录」。
4. 支持新建空文件夹，以及重命名/移动整个文件夹（后代路径前缀一起改）。
5. 文档只在删光带 `html_url` 的分享后离开归档树；不提供单独的「移出归档」。
6. 归档树对 Stale Archive Entry 显示「有未发布改动」；Working Tree 不加归档标记。
7. Default Archive Path 等于 `doc_key`，去掉「剥扩展名」以免 `notes.md` 与 `notes/a.md` 互斥。
8. 「有未发布改动」比较 Published Content Hash 与当前草稿，不用 `updated_at`。
9. 整夹改名对隐式/显式文件夹都生效，只替换 `from/` 前缀；文档不会落在恰好等于文件夹的路径上。
10. 离开归档树时保留 `archive_path`，再次归档复用。
