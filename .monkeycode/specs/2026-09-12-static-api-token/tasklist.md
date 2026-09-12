# 需求实施计划

- [x] 1. 数据层：users.api_token_hash
  - [x] 1.1 在 `src/server/db.ts` 为 `users` 增加 `api_token_hash` 列与唯一索引，并在 `initDB` 做增量迁移
  - [x] 1.2 扩展 `UserRow`，实现 `getUserByApiTokenHash` 与 `setUserApiTokenHash`（冲突返回 409）
    - 对应需求 Requirement 1.1 / 1.2 / 1.3 / 1.6，设计 Data Models

- [x] 2. 鉴权层：Bearer 与 Session 分流
  - [x] 2.1 在 `src/server/auth.ts` 增加 `validateApiToken`、`parseBearer`，并扩展 `requireUser`：存在 `Authorization` 头则只走 Bearer，成功路径不刷新 Cookie
    - 对应需求 Requirement 2、Requirement 3.1–3.3，设计 Components 1
  - [x] 2.2 `toPublicUser` 增加 `has_api_token`
    - 对应需求 Requirement 4.2

- [x] 3. 账号 API
  - [x] 3.1 在 `src/server/auth-api.ts` 增加 `POST /api/auth/token` 与 `DELETE /api/auth/token`；`GET /api/auth/me` 返回 `has_api_token`
    - 对应需求 Requirement 1、Requirement 4
  - [x] 3.2 为鉴权与 Token API 编写 `src/server/auth.test.ts` 用例（设置/轮换/清空、Bearer 优先、停用、改密保留、冲突 409、格式校验）
    - 对应设计 Test Strategy 1–7

- [x] 4. 检查点 - 确保所有测试通过
  - 运行 `npm test`，确保全部通过，如有疑问请询问用户

- [x] 5. 设置页
  - [x] 5.1 在 `src/ui/settings.ts` 增加 API Token 区块：已配置/未配置、保存、清空，明文不回显
    - 对应需求 Requirement 1.4、Requirement 4.1
