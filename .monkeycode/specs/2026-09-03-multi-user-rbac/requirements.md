# Requirements Document

## Introduction

将 PTDoc 从单用户个人文档工具升级为多用户、分角色平台。每位用户拥有完全独立的工作区，并配置自己的七牛云对象存储。平台提供两类角色：Platform Admin 与 Member。现有编辑、预览、文档树、媒体库、分享、快照、静态站点能力在用户隔离前提下继续可用。

已确认决策：

- 隔离模型：每用户完全独立 Workspace；Platform Admin 管理账号，不查看他人内容。
- 角色集合：Platform Admin + Member。
- 对象存储：每用户自行填写七牛云配置；上传与删除走该用户自己的桶。

## Glossary

- **System**：PTDoc 多用户平台（本文档中的系统）。
- **User**：持有账号、可登录系统的主体。
- **Role**：绑定到 User 的权限集合，取值仅为 Platform Admin 或 Member。
- **Platform Admin**：可管理全部 User 账号与角色，并可查看平台级运行状态。
- **Member**：可管理本人 Workspace 与本人 Storage Profile。
- **Workspace**：属于单个 User 的文档、媒体、分享、快照与 mermaid 缓存集合。
- **Storage Profile**：User 保存的七牛云凭证与桶配置，供该 User 的上传、删除、分享产物使用。
- **Session**：User 登录后获得的身份凭证，用于后续请求鉴权。
- **Current User**：发出当前请求且已通过鉴权的 User。
- **Setup Page**：当系统中尚不存在 User 时展示的初始化设置页，用于创建首位 Platform Admin 并完成必要服务端配置。
- **Settings Page**：已登录 User 用于查看与保存本人 Storage Profile 及账号安全项的界面。

## Requirements

### Requirement 1: 账号注册与登录

**User Story:** AS 新用户, I want 使用用户名与密码注册并登录, so that 我能进入属于自己的工作区。

#### Acceptance Criteria

1. WHEN 访客提交符合规则的用户名与密码, THE System SHALL 创建 Role 为 Member 的账号并返回已登录 Session。
2. WHEN 已注册 User 提交正确的用户名与密码, THE System SHALL 建立 Session 并进入该 User 的 Workspace。
3. IF 登录凭证与已有账号不匹配, THE System SHALL 拒绝登录并返回可展示的错误说明。
4. WHEN User 主动退出, THE System SHALL 使当前 Session 立即失效。
5. WHILE User 未持有有效 Session 且系统中已存在 User, THE System SHALL 仅允许访问注册与登录。
6. WHILE 系统中尚不存在 User, THE System SHALL 仅允许访问 Setup Page 与创建首位 Platform Admin 的接口。

### Requirement 2: 角色与权限

**User Story:** AS Platform Admin, I want 为 User 分配角色, so that 平台管理与日常写作权限分离。

#### Acceptance Criteria

1. THE System SHALL 为每个 User 绑定恰好一个 Role，取值范围为 Platform Admin 或 Member。
2. WHILE Current User 的 Role 为 Platform Admin, THE System SHALL 允许该 User 列出全部账号、停用账号、重置密码、变更 Role。
3. WHILE Current User 的 Role 为 Member, THE System SHALL 允许该 User 读写本人 Workspace 与本人 Storage Profile。
4. WHEN Platform Admin 将某个 User 的 Role 变更为 Platform Admin 或 Member, THE System SHALL 在该 User 的下一次鉴权请求起按新 Role 生效。
5. IF Current User 请求超出其 Role 的操作, THE System SHALL 拒绝该请求并返回权限不足说明。
6. WHILE Platform Admin 管理账号, THE System SHALL 保持各 User Workspace 内容对 Platform Admin 不可见。

### Requirement 3: 工作区数据隔离

**User Story:** AS Member, I want 只看到和操作我自己的文档与素材, so that 其他用户的内容保持私密。

#### Acceptance Criteria

1. WHEN Current User 列出文档、媒体、分享或快照, THE System SHALL 仅返回属于该 User 的 Workspace 记录。
2. WHEN Current User 读取、重命名、删除文档或恢复快照, THE System SHALL 仅在目标记录属于该 User 时执行操作。
3. WHEN Current User 生成分享版或写入 mermaid 缓存, THE System SHALL 将记录归属到该 User 的 Workspace。
4. IF Current User 使用其他 User 的文档、媒体、分享或快照标识发起读写, THE System SHALL 拒绝该请求。
5. THE System SHALL 以 `(user_id, doc_key)` 作为文档唯一约束，允许不同 User 使用相同路径名。

### Requirement 4: 每用户七牛云对象存储配置

**User Story:** AS Member, I want 填写我自己的七牛云信息, so that 我的图片和分享产物上传到我的存储桶。

#### Acceptance Criteria

1. WHEN Current User 提交完整的 Storage Profile（AccessKey、SecretKey、Bucket、Domain、Zone、是否私有桶、签名有效期）, THE System SHALL 保存该配置并仅绑定到该 User。
2. WHEN Current User 更新 Storage Profile, THE System SHALL 用新配置替换该 User 的既有配置，并在后续上传与删除请求中使用新配置。
3. WHEN Current User 发起图片上传、分享产物上传或媒体删除, THE System SHALL 使用该 User 的 Storage Profile 访问七牛云。
4. IF Current User 尚未保存完整 Storage Profile 且发起上传或对象删除, THE System SHALL 拒绝该操作并提示先完成存储配置。
5. WHEN Current User 查看 Storage Profile, THE System SHALL 展示非密钥字段的当前值，并对 SecretKey 仅显示已配置或未配置状态。
6. THE System SHALL 将 Storage Profile 中的密钥仅保存在服务端，避免写入前端打包产物，避免接口响应返回 SecretKey 明文。

### Requirement 5: 存储配置校验与连通性

**User Story:** AS Member, I want 保存前确认七牛云可用, so that 错误密钥不会在真正上传时才暴露。

#### Acceptance Criteria

1. WHEN Current User 请求测试 Storage Profile, THE System SHALL 使用所提交配置向七牛云发起一次连通性校验。
2. WHEN 连通性校验成功, THE System SHALL 返回成功状态。
3. IF 连通性校验失败, THE System SHALL 拒绝将失败配置标记为可用，并返回可展示的错误说明。
4. WHILE Storage Profile 校验未通过, THE System SHALL 继续使用该 User 上一次校验通过的配置（若存在）。

### Requirement 6: 会话保护与账号安全

**User Story:** AS User, I want 我的登录态和存储密钥受到保护, so that 他人无法冒用我的账号或存储。

#### Acceptance Criteria

1. THE System SHALL 使用服务端签发的 Session 识别 Current User，并在过期后要求重新登录。
2. WHEN User 修改本人密码, THE System SHALL 使该 User 既有 Session 全部失效，并仅保留本次改密后的新 Session。
3. THE System SHALL 以不可逆方式保存密码，避免明文落库。
4. THE System SHALL 以仅服务端可解密的方式保存 Storage Profile 的 SecretKey。
5. WHEN 连续登录失败次数达到 5 次, THE System SHALL 在 15 分钟内拒绝同一用户名的后续登录尝试。
6. WHEN Platform Admin 停用某个 User, THE System SHALL 立即失效该 User 的全部 Session。

### Requirement 7: 首次初始化与既有数据迁移

**User Story:** AS 平台部署者, I want 在设置页创建首位管理员并把旧数据归到该账号, so that 升级后无需依赖隐式环境变量引导。

#### Acceptance Criteria

1. WHEN 进程启动且缺少必要服务端环境变量 `PTDOC_DATA_KEY`, THE System SHALL 拒绝进入可用状态并返回明确错误说明。
2. WHEN 系统中尚不存在 User, THE System SHALL 展示 Setup Page，允许部署者提交用户名与密码以创建首位 Platform Admin。
3. WHEN 首位 Platform Admin 创建成功且存在无主 docs / shares / media / mermaid_cache 记录, THE System SHALL 将这些记录归属到该 Platform Admin 的 Workspace。
4. WHEN 迁移完成, THE System SHALL 保证原文档树、媒体库、分享记录在该 Platform Admin 登录后仍可打开。
5. THE System SHALL 避免用环境变量静默创建管理员账号或打印一次性随机密码。

### Requirement 8: 现有写作与发布能力在用户上下文中继续可用

**User Story:** AS Member, I want 继续使用文档树、TOC、快照、媒体库、分享和静态站点, so that 多用户改造不削弱现有写作闭环。

#### Acceptance Criteria

1. WHILE Current User 已登录, THE System SHALL 允许该 User 在本人 Workspace 内执行文档树增删改、互链跳转、TOC、快照；在 Storage Profile 可用时执行媒体库与生成分享版。
2. WHEN Current User 执行静态站点构建, THE System SHALL 仅将该 User Workspace 内的文档渲染为静态站点产物。
3. WHEN Current User 打开托管页 `/s/:id`, THE System SHALL 仅在该分享记录属于 Current User 时渲染对应 HTML。
4. IF 未登录访客或非所属 User 请求 `/s/:id`, THE System SHALL 拒绝展示该托管分享页。
5. WHEN 已登录 User 打开编辑器, THE System SHALL 加载该 User 自己的文档树、媒体库与分享记录，避免混入其他 User 的数据。
6. WHEN 同一浏览器切换账号, THE System SHALL 清空上一账号的编辑器状态并加载新账号 Workspace。
7. WHILE Current User 已登录, THE System SHALL 提供 Settings Page，供该 User 查看与保存本人 Storage Profile。

### Requirement 9: 账号管理界面

**User Story:** AS Platform Admin, I want 在界面中管理用户, so that 我无需直接改数据库。

#### Acceptance Criteria

1. WHILE Current User 的 Role 为 Platform Admin, THE System SHALL 提供账号列表，展示用户名、Role、状态、创建时间。
2. WHEN Platform Admin 停用或启用某个 User, THE System SHALL 更新该账号状态并立即影响其登录能力。
3. WHEN Platform Admin 重置某个 User 的密码, THE System SHALL 写入新密码哈希并使该 User 既有 Session 全部失效。
4. WHILE Current User 的 Role 为 Member, THE System SHALL 隐藏账号管理入口。
