# 需求实施计划

 - [x] 1. 数据模型与 Profile
   - [x] 1.1 在 `src/server/db.ts` 增加 llm/qdrant/extensions/conversations/turns/traces 表及 CRUD
   - [x] 1.2 增加 `getDocByKey`，供 apply-draft 创建模式冲突检测
   - [x]* 1.3 为 Profile 与 Conversation 隔离写单元测试

 - [x] 2. Qdrant 检索与草稿 Diff
   - [x] 2.1 实现 `src/server/qdrant-retriever.ts`（文本 query、payload 映射、可注入 client）
   - [x] 2.2 实现 `src/server/draft-diff.ts` 行级差异
   - [x]* 2.3 检索映射与 Diff 单元测试

 - [x] 3. Extension Store
   - [x] 3.1 实现 zip 解压、Skill/Plugin 覆盖、MCP 配置持久化
   - [x] 3.2 Plugin `npm install` 可注入；保存后试加载
   - [x]* 3.3 覆盖/缺 SKILL.md/重名/安装失败测试

 - [x] 4. Agent Runtime 与 API
   - [x] 4.1 `agent-runtime.ts`：按请求构造 OpenAI 兼容模型，挂检索/读写工具，流式 UI Message
   - [x] 4.2 `agent-api.ts`：LLM/Qdrant/对话/chat/handoff/apply-draft/stop/retrieve/Admin 扩展
   - [x] 4.3 `vite.config.ts` 挂中间件并 `initAgentRuntime`
   - [x]* 4.4 agent-api 鉴权、400/403/409 与 apply-draft 测试

 - [x] 5. 检查点 - 确保服务端测试通过
   - 确保所有测试通过,如有疑问请询问用户

 - [x] 6. 前端
   - [x] 6.1 Settings 增加 LLM / Qdrant
   - [x] 6.2 Admin 增加智能体扩展页
   - [x] 6.3 对话抽屉：流式、可观测、Handoff、Citation Insert、Draft Diff

 - [x] 7. 检查点 - 类型检查与测试
   - 确保所有测试通过,如有疑问请询问用户
