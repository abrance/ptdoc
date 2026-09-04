# Requirements Document

## Introduction

将「上传到七牛云」重新定义为 **归档（Archive）**：Current User 把工作副本写入本人对象存储后，得到可浏览、可整理、可打标签的归档文件。System 提供归档目录树，允许自由组织路径并用拖拽调整；已归档文件可重新打开编辑，Current User 显式执行再归档后覆盖对象存储中的正文。

本需求建立在多用户隔离与每用户 Storage Profile 之上：归档树、标签与再归档仅作用于 Current User 的 Workspace。

已确认决策：

- 归档对象仅为 **Markdown 文档**；图片留在媒体库，不单独占归档树节点。
- 归档目录树与工作区 `doc_key` 树 **相互独立**：工作区继续用于日常编写，归档树描述展示用的 Archive Path。
- 再归档 **覆盖** 同一归档对象的正文与对象存储内容；System 保留最近一次归档时间，不自动保留多版历史。
- 工作区仍按现有节奏自动保存到 `docs`；覆盖对象存储仅由顶栏「归档 / 再归档」触发。
- 归档库为右侧抽屉，与媒体库、分享记录同构。
- Archive Path 与对象存储 key 分离：拖拽与重命名只改展示路径，访问地址保持不变。

## Glossary

- **System**：PTDoc 平台。
- **Current User**：已通过鉴权、发出当前请求的 User。
- **Workspace**：属于单个 User 的文档、媒体、分享与归档集合。
- **Working Copy**：编辑器中正在编写的文档正文，尚未或不必与归档对象同步。
- **Archive Action**：把 Working Copy 写入 Current User 的对象存储，并在 Workspace 中登记为归档对象。
- **Archive Item**：一次成功 Archive Action 后形成的归档对象，包含可见路径、正文引用、对象存储地址与标签。
- **Archive Tree**：Current User 名下全部 Archive Item 按路径分层得到的目录树。
- **Archive Path**：Archive Item 在 Archive Tree 中的位置，形如 `folder/sub/name.md`，由 Current User 组织，与工作区 `doc_key` 独立。
- **Tag**：Current User 为 Archive Item 附加的短文本标签。
- **Re-archive**：Current User 对已打开的 Archive Item 显式执行「再归档」，用当前 Working Copy 覆盖该对象。
- **Storage Profile**：Current User 已验证的七牛云配置。

## Requirements

### Requirement 1: 上传即归档

**User Story:** AS Member, I want 把当前文档归档到我的对象存储, so that 我得到一份可公开访问且可再整理的存档。

#### Acceptance Criteria

1. WHEN Current User 对一篇 Working Copy 执行 Archive Action 且已配置完整 Storage Profile, THE System SHALL 将该文档正文上传到该 User 的对象存储，并创建或更新对应 Archive Item。
2. WHEN Archive Action 成功, THE System SHALL 为该 Archive Item 分配 Archive Path，默认使用工作区 `doc_key`；若该路径已被同一 User 的另一 Archive Item 占用，THE System SHALL 提示 Current User 选择新路径后再完成归档。
3. IF Current User 尚未保存完整 Storage Profile 且发起 Archive Action, THE System SHALL 拒绝该操作并提示先完成对象存储配置。
4. WHEN Archive Action 成功, THE System SHALL 在界面用「归档」措辞展示结果，并给出该 Archive Item 的对象存储访问地址。

### Requirement 2: 归档目录树

**User Story:** AS Member, I want 以目录树查看我已归档的文件, so that 我能按文件夹定位存档。

#### Acceptance Criteria

1. WHEN Current User 打开归档视图, THE System SHALL 仅展示属于该 User 的 Archive Item，并按 Archive Path 的 `/` 分段渲染可折叠目录树。
2. WHILE 归档视图打开, THE System SHALL 显示每个 Archive Item 的文件名、最近归档时间与标签列表。
3. WHEN Current User 选中一棵树中的 Archive Item, THE System SHALL 高亮该节点并展示该对象的路径、访问地址与标签。
4. IF Current User 的 Workspace 中尚无 Archive Item, THE System SHALL 展示空状态说明，引导执行第一次归档。

### Requirement 3: 自由组织归档路径

**User Story:** AS Member, I want 自行调整归档文件的目录结构, so that 对象存储中的组织方式符合我的分类习惯。

#### Acceptance Criteria

1. WHEN Current User 在归档视图新建文件夹, THE System SHALL 在 Archive Tree 中创建该文件夹节点，供后续放入 Archive Item。
2. WHEN Current User 将 Archive Item 重命名或移动到新的 Archive Path, THE System SHALL 更新该对象的展示路径，并保持该对象的对象存储访问地址不变。
3. IF 目标 Archive Path 已被同一 User 的另一 Archive Item 占用, THE System SHALL 拒绝该次重命名或移动，并提示路径冲突。
4. WHEN Current User 删除 Archive Item, THE System SHALL 从该 User 的 Archive Tree 移除该对象，并删除对象存储中对应文件。
5. WHEN Current User 删除空文件夹, THE System SHALL 从 Archive Tree 移除该文件夹节点。

### Requirement 4: 拖拽整理

**User Story:** AS Member, I want 用拖拽调整归档树, so that 整理目录不必反复填写路径。

#### Acceptance Criteria

1. WHEN Current User 将一个 Archive Item 拖到某个文件夹节点上释放, THE System SHALL 把该对象的 Archive Path 更新到目标文件夹下，保持原文件名，并保持对象存储访问地址不变。
2. WHEN Current User 将一个文件夹拖到另一个文件夹节点上释放, THE System SHALL 把源文件夹及其全部后代 Archive Item 的路径更新到目标文件夹下，并保持各对象的对象存储访问地址不变。
3. IF 拖拽目标会造成路径冲突或把文件夹放入其自身后代, THE System SHALL 保持原树结构不变，并提示原因。
4. WHEN 一次拖拽导致多个 Archive Item 路径更新, THE System SHALL 在同一次操作中完成全部更新，避免出现部分已移动、部分仍在原路径的中间状态。

### Requirement 5: 归档标签

**User Story:** AS Member, I want 给已归档文件打标签, so that 我能按主题筛选存档。

#### Acceptance Criteria

1. WHEN Current User 为 Archive Item 添加 Tag, THE System SHALL 将该 Tag 绑定到该对象；同一对象上相同文本的 Tag 只保留一条。
2. WHEN Current User 移除 Archive Item 上的某个 Tag, THE System SHALL 解除该绑定，并保持其余 Tag 不变。
3. WHEN Current User 在归档视图按 Tag 筛选, THE System SHALL 仅展示带有所选 Tag 的 Archive Item，并保持其所在文件夹层级可见。
4. THE System SHALL 将 Tag 限定为 1 到 24 个字符，字符范围为字母、数字、中文、连字符与下划线。

### Requirement 6: 再编辑与再归档

**User Story:** AS Member, I want 打开已归档文件继续改, so that 我点「再归档」后对象存储中的存档与编辑器内容一致。

#### Acceptance Criteria

1. WHEN Current User 从归档视图打开 Archive Item, THE System SHALL 将该对象正文载入编辑器作为 Working Copy，并标记当前正在编辑该归档对象。
2. WHEN Current User 在编辑已打开的 Archive Item 时执行 Re-archive, THE System SHALL 用当前 Working Copy 覆盖该 Archive Item 的正文与对象存储内容，并更新最近归档时间。
3. WHILE 编辑器中的 Working Copy 相对已打开 Archive Item 有未归档修改, THE System SHALL 在归档视图与编辑器状态区提示存在未归档改动。
4. IF Current User 在存在未归档改动时打开另一篇 Archive Item 或工作区文档, THE System SHALL 先提示执行 Re-archive 或放弃本次未归档改动，再切换目标。
5. WHEN Current User 仅将 Working Copy 写入工作区文档（含自动保存）, THE System SHALL 保持对应 Archive Item 的对象存储内容不变，直至 Current User 执行 Re-archive。

### Requirement 7: 隔离与权限

**User Story:** AS Member, I want 只整理我自己的归档, so that 其他用户的存档保持私密。

#### Acceptance Criteria

1. WHEN Current User 列出、移动、打标签、打开或再归档, THE System SHALL 仅作用于属于该 User 的 Archive Item。
2. IF Current User 使用其他 User 的归档标识发起读写, THE System SHALL 将该请求视为目标不存在。
3. WHILE Current User 的 Role 为 Platform Admin, THE System SHALL 继续仅允许该 User 管理账号，归档树内容对 Platform Admin 保持不可见（Admin 本人 Workspace 除外）。

### Requirement 8: 归档库入口

**User Story:** AS Member, I want 从编辑器打开归档库抽屉, so that 我整理存档时不必离开当前写作界面。

#### Acceptance Criteria

1. WHEN Current User 打开归档库, THE System SHALL 以右侧抽屉展示 Archive Tree，工作区文档树保持在左侧。
2. WHILE 归档库抽屉打开, THE System SHALL 允许 Current User 浏览、拖拽、打标签、打开 Archive Item，而不关闭编辑器。
