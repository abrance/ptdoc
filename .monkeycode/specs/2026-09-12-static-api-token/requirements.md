# Requirements Document

## Introduction

为每位 User 增加一枚可自行设置的静态 API Token，使脚本、curl 等非浏览器客户端能通过 `Authorization: Bearer` 完成与 Session Cookie 等价的接口鉴权。Token 由 User 自己填写（大小写字母与数字），服务端只保存哈希。权限、工作区隔离、停用策略与现有 Session 鉴权一致。

已确认决策：

- 传递方式：`Authorization: Bearer <token>`。
- Cookie 与 Bearer 同时出现时，以 Bearer 为准。
- Token 由 User 自行填写，设置页可随时更改或清空；服务端只存哈希，接口不回说明文。
- 长度：16–64 位，字符集为大小写字母与数字。
- 覆盖范围：全部现有需登录接口（含 admin、upload、docs、share、media、storage、archive、`/s/:id`、`/api/auth/me`、`/api/auth/password`）。
- 公开入口保持公开：`/api/setup`、`/api/setup/status`、`/api/auth/register`、`/api/auth/login`。

默认约定（本轮按此实现，有异议再说）：

- 每个 User 最多一枚有效 API Token。
- Token 在全站用户间唯一；重复提交返回冲突说明。
- 未设置 API Token 的 User，Bearer 鉴权失败。
- 请求带了 `Authorization` 头则只走 Bearer，不再回退 Cookie。
- Bearer 鉴权成功时不签发、不刷新 Session Cookie。
- 账号停用后，Bearer 与 Cookie 一样被拒绝。
- 修改登录密码、退出登录，均保持该 User 的 API Token 有效。
- Platform Admin 不能查看或代设其他 User 的 API Token；停用账号即可挡住对方的 Bearer 请求。

## Glossary

- **System**：PTDoc 多用户平台（本文档中的系统）。
- **User**：持有账号、可登录系统的主体。
- **Current User**：发出当前请求且已通过鉴权的 User。
- **Session**：User 登录后获得的 Cookie 身份凭证（`ptdoc_session`）。
- **API Token**：User 自行设置的静态访问口令，字符为大小写字母与数字，长度 16–64。
- **Bearer 凭证**：HTTP 请求头 `Authorization` 中 `Bearer` 方案携带的 API Token 明文。
- **Settings Page**：已登录 User 用于查看与保存本人 Storage Profile、登录密码与 API Token 的界面。

## Requirements

### Requirement 1: 设置与轮换 API Token

**User Story:** AS Member, I want 在设置里为自己指定一枚静态 Token, so that 我能用脚本调用接口而不依赖浏览器 Cookie。

#### Acceptance Criteria

1. WHEN Current User 提交长度为 16–64、仅含大小写字母与数字的 API Token, THE System SHALL 保存该 Token 的哈希并绑定到该 User。
2. WHEN Current User 再次提交符合规则的新 API Token, THE System SHALL 用新哈希替换旧哈希，并使旧 Token 立即失效。
3. WHEN Current User 请求清空 API Token, THE System SHALL 移除该 User 的 Token 哈希。
4. WHEN Current User 打开 Settings Page, THE System SHALL 展示该 User 是否已配置 API Token，并提供输入新值与清空的操作。
5. IF Current User 提交的 API Token 长度或字符集不符合规则, THE System SHALL 拒绝保存并返回可展示的错误说明。
6. IF Current User 提交的 API Token 与其他 User 已保存的 Token 冲突, THE System SHALL 拒绝保存并返回冲突说明。

### Requirement 2: Bearer 鉴权等价于已登录

**User Story:** AS 脚本调用方, I want 在请求头带上我的 Token, so that 我能访问与登录后相同的接口。

#### Acceptance Criteria

1. WHEN 请求携带合法 Bearer 凭证且对应用户状态为 active, THE System SHALL 将该请求的 Current User 识别为该 Token 所属 User。
2. WHEN 请求未携带 `Authorization` 头且携带有效 Session Cookie, THE System SHALL 继续按现有 Session 鉴权识别 Current User。
3. WHEN 请求同时携带 `Authorization` 头与 Session Cookie, THE System SHALL 仅根据 Bearer 凭证识别 Current User。
4. WHEN 请求通过 Bearer 凭证通过鉴权, THE System SHALL 按该 User 的 Role 与 Workspace 隔离执行后续操作，效果与 Session 鉴权相同。
5. WHILE Current User 通过 Bearer 凭证访问需登录接口, THE System SHALL 保持响应不签发、不刷新 Session Cookie。

### Requirement 3: 失败与停用

**User Story:** AS Platform Admin, I want 无效或停用账号的 Token 被拒绝, so that 接口不会被未知调用方使用。

#### Acceptance Criteria

1. IF 请求携带 `Authorization` 头但 Bearer 凭证缺失、格式无效、或与任何已配置 Token 不匹配, THE System SHALL 拒绝该请求并返回未登录说明。
2. IF Bearer 凭证所属 User 的状态为 disabled, THE System SHALL 拒绝该请求并返回账号已停用说明。
3. IF User 尚未配置 API Token 且请求携带 `Authorization` 头, THE System SHALL 拒绝该请求并返回未登录说明。
4. WHEN Platform Admin 停用某个 User, THE System SHALL 在该 User 的下一次 Bearer 请求起拒绝访问。

### Requirement 4: 安全展示与权限边界

**User Story:** AS Member, I want Token 明文只在我自己手里, so that 服务端和别人都拿不到我的口令。

#### Acceptance Criteria

1. THE System SHALL 仅存储 API Token 的哈希，接口响应与 Settings Page 均不返回 Token 明文。
2. WHEN Current User 查询本人资料, THE System SHALL 返回是否已配置 API Token 的布尔状态。
3. WHILE Current User 管理本人 API Token, THE System SHALL 仅允许该 User 设置、更换或清空本人的 Token。
4. WHEN Current User 修改登录密码或退出登录, THE System SHALL 保持该 User 已配置的 API Token 仍然有效。
