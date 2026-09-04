# 需求实施计划

- [x] 1. 启动校验与多用户表结构
  - [x] 1.1 在 `src/server/env.ts` 读取并校验 `PTDOC_DATA_KEY`（32 字节 hex）与可选 `PTDOC_SESSION_TTL_DAYS`
    - 缺失或格式非法时抛出明确错误，供 `vite.config.ts` 在 `initDB()` 前调用
    - 对应 Requirement 7.1
  - [x] 1.2 扩展 `src/server/db.ts`：新增 `users` / `sessions` / `storage_profiles` / `schema_meta`
    - 为 `docs` / `shares` / `media` / `mermaid_cache` 增加 `user_id`（默认 0 表示无主）
    - 重建 `UNIQUE(user_id, doc_key)` 与 `PRIMARY KEY (user_id, mermaid_hash)`
    - 用 `schema_meta.multi_user=1` 保证迁移只跑一次
    - 对应 Requirement 3.5、7.3
  - [x] 1.3 在 `vite.config.ts` 接入启动校验；`server.allowedHosts` 加入 `.monkeycode-ai.online`
    - 去掉运行期对 `initQiniu(env)` 全局单例的依赖
    - 对应 Requirement 7.1、4.6
  - [x] 1.4 为环境变量校验与 schema 迁移编写单元测试
    - 夹具：旧四表库启动后含 `user_id` 列且 `users` 仍为空

- [x] 2. 鉴权与首次 Setup
  - [x] 2.1 实现 `src/server/auth.ts`：scrypt 密码、Session Cookie、滑动过期、登录失败锁定、`requireUser` / `requireAdmin`
    - Cookie 名 `ptdoc_session`，httpOnly、SameSite=Lax
    - 对应 Requirement 1、6.1、6.3、6.5
  - [x] 2.2 实现 `src/server/auth-api.ts`：`GET /api/setup/status`、`POST /api/setup`、register / login / logout / me / password
    - `POST /api/setup` 仅在 `users` 为空时创建 Platform Admin，并把 `user_id=0` 的无主记录归属到该账号
    - 已初始化后 `POST /api/setup` 返回 409；register 创建 Member
    - 改密后删除该用户全部 Session 并签发新 Cookie
    - 对应 Requirement 1、6.2、7.2、7.3、7.4、7.5
  - [x] 2.3 前端 `src/ui/setup.ts` 与 `src/ui/auth.ts`：未初始化进 Setup Page，已初始化进登录/注册，挡住编辑器
    - 启动时请求 `/api/setup/status` 分流
    - 对应 Requirement 1.5、1.6、7.2
  - [x] 2.4 为密码哈希、Session 轮换、锁定、Setup 只允许一次编写单元测试

- [x] 3. 检查点 - 确保 Setup 后可登录且旧文档归到首位 Admin
  - 确保所有测试通过,如有疑问请询问用户

- [x] 4. 工作区按 user_id 隔离
  - [x] 4.1 改造 `src/server/db.ts` 全部 docs / shares / media / snapshots / mermaid_cache 查询与写入，强制 `user_id` 谓词
    - 跨用户 id 视为不存在
    - 对应 Requirement 3.1–3.4
  - [x] 4.2 改造 `src/server/api.ts`：除 setup/login/register 外均 `requireUser`，从 Session 注入 `user_id`
    - `GET /s/:id` 需登录且 `share.user_id === currentUser.id`，否则 404
    - 对应 Requirement 1.5、8.3、8.4
  - [x] 4.3 改造 `scripts/build-site.ts` 增加 `--user <id|username>`，只渲染该用户 Workspace
    - 未指定用户时给出明确错误
    - 对应 Requirement 8.2
  - [x] 4.4 前端 IndexedDB 句柄键改为 `${userId}:${doc_key}`；切换账号清空编辑器 / 搜索索引 / 面板缓存
    - 对应 Requirement 8.5、8.6
  - [x] 4.5 为隔离与同名 `doc_key`、mermaid_cache 按用户隔离编写单元测试
    - 对应 Correctness：读写 user_id 等于 Session；跨用户 404

- [x] 5. 检查点 - 确保两用户数据互不可见
  - 确保所有测试通过,如有疑问请询问用户

- [x] 6. 每用户七牛 Storage Profile
  - [x] 6.1 实现 `src/server/storage.ts`：AES-256-GCM 加解密 SK、`getProfile` / `saveProfile`、连通性校验
    - 校验使用 BucketManager 对目标桶做无副作用探测
    - 对应 Requirement 4.6、5.1–5.4
  - [x] 6.2 改造 `src/server/qiniu-uploader.ts`：`uploadToQiniu` / `deleteFromQiniu` 改为接受 per-request `QiniuConfig`，删除进程级单例
    - 对应 Requirement 4.3
  - [x] 6.3 实现 `GET/PUT /api/storage` 与 `POST /api/storage/test`；响应用 `secret_configured` 代替 SK 明文
    - 未校验通过的配置不覆盖已验证 Profile
    - 对应 Requirement 4.1、4.2、4.5、5.3、5.4
  - [x] 6.4 改造 `src/server/upload-api.ts` 与媒体删除：从 Current User Profile 取配置；缺失则 400「请先完成对象存储配置」
    - 对应 Requirement 4.3、4.4
  - [x] 6.5 前端 Settings 抽屉（`src/ui/settings.ts`）：展示非密钥字段、SK 仅「已配置/未配置」、测试连通性、保存
    - 顶栏「设置」入口；未配置时上传/分享给出同一提示
    - 对应 Requirement 4、8.1、8.7
  - [x] 6.6 为加密往返、响应不含 SK、无 Profile 时 upload 返回 400 编写单元测试

- [x] 7. 角色与账号管理
  - [x] 7.1 实现 `/api/admin/users` 列表、改角色、停用/启用、重置密码
    - Member 访问返回 403；列表不含文档正文与存储密钥
    - 停用或重置密码时删除该用户全部 Session
    - 对应 Requirement 2.2、2.5、2.6、6.6、9.2、9.3
  - [x] 7.2 前端账号管理抽屉：仅 `role=admin` 显示入口；列表展示用户名、角色、状态、创建时间
    - Member 隐藏入口
    - 对应 Requirement 2.3、9.1、9.4
  - [x] 7.3 为 admin/member 权限边界与停用立即失效 Session 编写单元测试

- [x] 8. 检查点 - 确保存储配置、隔离、角色管理闭环可用
  - 确保所有测试通过,如有疑问请询问用户

- [x] 9. 配置模板与类型检查
  - [x] 9.1 更新 `.env.example`：保留 `PTDOC_DATA_KEY` / `PTDOC_SESSION_TTL_DAYS` / 端口；将 `QINIU_*` 标为已废弃、改由 Settings Page 填写
    - 对应 Requirement 7.1、4.6
  - [x] 9.2 运行 `npm run typecheck` 并修复本轮引入的类型错误
