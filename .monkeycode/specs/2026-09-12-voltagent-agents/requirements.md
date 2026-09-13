# Requirements Document

## Introduction

在现有 PTDoc 多用户 Markdown 工作区上，增加两个 VoltAgent 智能体场景：知识库问答、Markdown 文档编写。知识库问答通过远程 Qdrant 检索文档与关键片段；文档编写智能体协助起草、改写并写回工作区文档。Platform Admin 全局配置 MCP、Skill、插件，配置与安装产物在 Docker Compose 重建后保持可用。对话界面展示 VoltAgent 可观测数据（检索来源、工具调用、耗时、Token），让本轮有价值的上下文可直接阅读。

已确认决策：

- 运行时：VoltAgent。
- 大模型：OpenAI 兼容接口（DeepSeek 等），用户可自行填写 Base URL、API Key、模型名。
- 知识库检索：对接远程 Qdrant，本阶段只检索已有 collection，不把工作区文档向量化入库。
- 扩展能力：仅 Platform Admin 对 MCP、Skill、插件做增、删、查、改；改与重新上传采用整份覆盖；所有 User 共用已启用扩展。
- Markdown 写回：先出草稿，再展示与目标文档的 Draft Diff，Current User 接受后才落盘。
- 闭环：问答轮次可 Handoff 给编写智能体；Retrieved Hit 可引用并 Citation Insert 到当前文档。
- 持久化：MCP / Skill / 插件在 docker compose 重建容器后仍存在。
- 对话界面：整合 VoltAgent 可观测体系，展示本轮检索、工具、耗时、Token 等上下文。

已确认默认约定：

- LLM Profile、Qdrant Profile、Conversation、Trace 按 User 隔离；配置入口在 Settings Page。
- MCP / Skill / 插件由 Platform Admin 在管理页做增删查改（更新整份覆盖），Member 只读已启用扩展的名称与类型。
- 知识库问答只检索远程 Qdrant 已有 collection。
- 知识库问答以检索工具形式调用：智能体按问题决定是否检索，返回 top-k（默认 5）命中，含文档标识、标题或路径、片段、相似度分数。
- Markdown 编写智能体可读取当前打开文档与工作区文档树；草稿先对目标文档做 Draft Diff，Current User 接受后才落盘。
- 问答轮次提供 Handoff：新编写 Conversation 携带该轮问题、回答与 Retrieved Hits。
- Retrieved Hit 在回答中可点开片段，并支持 Citation Insert 到当前打开文档的光标处。
- MCP 支持 http / streamable-http / sse / stdio 四类传输。
- Skill 为指令包（含 SKILL.md 与可选资源文件）；插件为可启用的工具包。
- 可观测数据默认落在宿主机挂载卷上的本地存储，对话页内嵌时间线；VoltOps 云端导出为可选。
- 对话流式输出；上下文以当前 Conversation 的全部轮次为准；User 可新建 Conversation，也可删除历史 Conversation。
- Skill / 带文件的 Plugin 以 zip 上传，Skill 的 zip 根目录必须含 SKILL.md；更新时整包覆盖。
- stdio 型 MCP 允许 Platform Admin 指定任意 command 与参数，进程在服务端启动。
- 远程 Qdrant collection 已启用服务端向量化，PTDoc 只发送问题原文做检索。
- Agent Runtime 与 PTDoc API 同进程，对外只暴露 PREVIEW_PORT。
- Plugin zip 根目录为 ESM `index.js` 或 `index.mjs`，导出 VoltAgent tools 数组。
- 鉴权、角色、工作区隔离沿用现有 Session / Bearer 与 RBAC。
- 对话响应使用 VoltAgent / AI SDK UI Message Stream；请求仍由服务端拼 Conversation 历史。
- Qdrant 文本 query 不传 inference 模型名，依赖 collection 已绑定的向量化。
- Plugin zip 保存后在解压目录执行 `npm install --omit=dev`，`node_modules` 留在 Host Volume。
- 远程知识库为自建 Qdrant + FastEmbed；PTDoc 只发问题原文做 query。

## Glossary

- **System**：PTDoc 多用户平台及其 VoltAgent 智能体运行时（本文档中的系统）。
- **User**：持有账号、可登录系统的主体。
- **Current User**：发出当前请求且已通过鉴权的 User。
- **Workspace**：属于单个 User 的文档、媒体、分享、快照集合。
- **Agent Runtime**：基于 VoltAgent 的智能体运行时，负责对话、工具、MCP、Skill、插件与可观测采集。
- **Knowledge QA Agent**：知识库问答智能体，通过远程 Qdrant 检索后回答。
- **Markdown Writer Agent**：Markdown 文档编写智能体，协助起草、改写并写回 Workspace 文档。
- **Agent Scene**：智能体场景，取值仅为 Knowledge QA Agent 或 Markdown Writer Agent。
- **LLM Profile**：Current User 保存的大模型接入配置，含 Base URL、API Key、模型名。
- **Qdrant Profile**：Current User 保存的远程 Qdrant 接入配置，含 URL、可选 API Key、collection 名、可选 vector 名；检索把问题原文交给 Qdrant 做服务端向量化。
- **MCP Server Config**：一条 MCP 服务配置，含名称、传输类型、连接参数、启用状态。
- **Skill Pack**：一套可启用的智能体技能指令与资源文件。
- **Plugin Pack**：一套可启用的工具扩展。
- **Platform Admin**：可管理全部 User 账号，并管理全局 MCP / Skill / 插件。
- **Member**：可管理本人 Workspace、LLM Profile、Qdrant Profile 与对话，可使用已启用的全局扩展。
- **Extension Store**：平台级持久化存储，存放全局 MCP Server Config、Skill Pack、Plugin Pack 及其安装产物，位于宿主机挂载卷。
- **Admin Extensions Page**：Platform Admin 用于对全局 MCP / Skill / 插件做新增、列表、详情、更新覆盖、删除、启用与停用的界面。
- **Overwrite Update**：更新已有扩展时，用本次提交的配置或文件整体替换旧值；Skill / Plugin 的目录文件以新包为准，旧文件不再保留。
- **Conversation**：Current User 与某一个 Agent Scene 的一次连续对话。
- **Turn**：Conversation 中的一轮用户输入与智能体响应。
- **Trace**：VoltAgent 为一次 Turn 记录的可观测数据，含 span、工具调用、检索引用、耗时、Token。
- **Retrieved Hit**：Qdrant 返回的一条检索结果，含文档标识、标题或路径、文本片段、相似度分数。
- **Handoff**：从某一轮知识库问答把问题、回答、Retrieved Hits 交给 Markdown Writer Agent 开启编写 Conversation 的操作。
- **Draft Diff**：草稿与目标文档全文的行级差异预览，供 Current User 接受或取消。
- **Citation Insert**：把一条 Retrieved Hit 的标题与片段插入当前打开文档光标处。
- **Observability Panel**：对话界面中展示 Trace 的区域。
- **Settings Page**：已登录 User 用于保存本人 LLM Profile 与 Qdrant Profile 的界面。
- **Host Volume**：Docker Compose 挂载到容器内的宿主机目录，容器重建后内容仍在。

## Requirements

### Requirement 1: 大模型接入与智能体运行时

**User Story:** AS Member, I want 为自己配置 DeepSeek 或其他 OpenAI 兼容大模型, so that 两个智能体场景都能用我自己的接口对话。

#### Acceptance Criteria

1. THE System SHALL 提供 Knowledge QA Agent 与 Markdown Writer Agent 两个 Agent Scene。
2. WHEN Current User 提交完整的 LLM Profile（Base URL、API Key、模型名）, THE System SHALL 保存该配置并仅绑定到该 User。
3. WHEN Current User 发起某一 Agent Scene 的对话, THE System SHALL 使用该 User 的 LLM Profile 调用对应 OpenAI 兼容接口。
4. WHEN Current User 查看 LLM Profile, THE System SHALL 展示 Base URL 与模型名，并对 API Key 仅显示已配置或未配置状态。
5. THE System SHALL 将 LLM Profile 中的 API Key 仅保存在服务端，避免写入前端打包产物，避免接口响应返回 API Key 明文。
6. IF Current User 尚未保存完整 LLM Profile 且发起对话, THE System SHALL 拒绝该对话并提示先完成大模型配置。

### Requirement 2: 知识库问答智能体

**User Story:** AS Member, I want 向知识库问答智能体提问, so that 系统从远程 Qdrant 找出相关文档和关键片段并据此作答。

#### Acceptance Criteria

1. WHEN Current User 提交完整的 Qdrant Profile（URL、collection 名，以及可选 API Key 与 vector 名）, THE System SHALL 保存该配置并仅绑定到该 User。
2. WHEN Current User 向 Knowledge QA Agent 发送问题, THE System SHALL 把问题原文发给该 User 的远程 Qdrant collection 做检索，并使用该 collection 已配置的服务端向量化。
3. WHEN Qdrant 返回命中, THE System SHALL 向 Knowledge QA Agent 提供不超过 top-k 条 Retrieved Hit，k 默认值为 5，每条包含文档标识、标题或路径、文本片段、相似度分数。
4. WHEN Knowledge QA Agent 生成回答, THE System SHALL 在回答中引用实际使用的 Retrieved Hit，并在 Observability Panel 列出这些引用。
5. WHEN Current User 点开一条 Retrieved Hit, THE System SHALL 展示该条的文档标识、标题或路径、相似度分数与完整片段。
6. WHEN Current User 对一条 Retrieved Hit 执行 Citation Insert 且当前已打开 Workspace 文档, THE System SHALL 在编辑器光标处插入含标题与片段的 Markdown。
7. IF Current User 执行 Citation Insert 但当前未打开 Workspace 文档, THE System SHALL 提示先打开或新建文档，并保持工作区内容不变。
8. IF Qdrant 在 8 秒内无有效响应、拒绝文本查询或返回空命中, THE System SHALL 向 Current User 展示可阅读的失败或空结果说明，并完成本轮 Trace。
9. IF Current User 尚未保存完整 Qdrant Profile 且向 Knowledge QA Agent 发送问题, THE System SHALL 拒绝检索并提示先完成知识库配置。

### Requirement 3: Markdown 文档编写智能体

**User Story:** AS Member, I want 让文档编写智能体根据我的要求起草或改写 Markdown, so that 我能把结果写进当前文档或新建文档。

#### Acceptance Criteria

1. WHEN Current User 向 Markdown Writer Agent 发送编写请求且当前已打开一篇 Workspace 文档, THE System SHALL 把该文档的 doc_key、标题与全文作为本轮上下文提供给该智能体。
2. WHEN Current User 要求查看工作区文档列表, THE System SHALL 仅返回属于该 User 的文档树节点（路径与标题）。
3. WHEN Markdown Writer Agent 产出一份完整 Markdown 草稿, THE System SHALL 在对话中展示该草稿，并提供目标选择：当前打开文档或另存为新文档。
4. WHEN Current User 选定目标文档, THE System SHALL 展示草稿与目标全文的整份行级 Draft Diff，并提供「接受」与「取消」。
5. WHEN Current User 接受整份 Draft Diff 且目标为当前打开文档, THE System SHALL 用草稿全文写入该文档并触发与编辑器一致的自动保存。
6. WHEN Current User 接受整份 Draft Diff 且目标为新文档并提交合法 doc_key, THE System SHALL 创建该文档并写入草稿全文。
7. IF Current User 取消 Draft Diff, THE System SHALL 保持 Workspace 文档内容不变。

### Requirement 4: Platform Admin 对 MCP、Skill、插件做增删查改

**User Story:** AS Platform Admin, I want 在管理页对 MCP / Skill / 插件做新增、查询、更新覆盖和删除, so that 全站两个智能体共用且可维护同一套扩展。

#### Acceptance Criteria

1. WHEN Platform Admin 提交一条尚不存在的合法 MCP Server Config（名称、传输类型为 http 或 streamable-http 或 sse 或 stdio、对应连接参数）, THE System SHALL 创建记录、写入 Extension Store，并返回新标识、名称、类型、启用状态。
2. WHEN Platform Admin 上传一个尚不存在的 Skill zip（根目录含 SKILL.md）或 Plugin zip, THE System SHALL 解压到 Extension Store、创建记录，并返回新标识。
3. WHEN Platform Admin 请求扩展列表并可附带 kind 与名称关键词, THE System SHALL 返回匹配的 MCP Server Config、Skill Pack 与 Plugin Pack，每条含标识、名称、类型、启用状态、更新时间。
4. WHEN Platform Admin 按标识读取一条扩展, THE System SHALL 返回该条完整非密钥配置；Skill 与 Plugin 另返回文件名列表。
5. WHEN Platform Admin 按标识提交 MCP Server Config 的更新, THE System SHALL 用本次字段整体覆盖旧连接参数；未提交的密钥字段保持原密文，已提交的密钥字段替换原密文。
6. WHEN Platform Admin 按标识重新上传 Skill zip 或 Plugin zip, THE System SHALL 解压后整体覆盖该标识对应目录中的旧文件，并使后续对话加载新内容。
7. WHEN Platform Admin 启用一条扩展, THE System SHALL 在后续所有 User 的两个 Agent Scene 对话中加载该扩展。
8. WHEN Platform Admin 停用一条扩展, THE System SHALL 从后续所有 User 的对话中卸载该扩展，并在 Extension Store 中将启用状态写为停用。
9. WHEN Platform Admin 按标识删除一条扩展, THE System SHALL 移除 Extension Store 中的记录与对应文件，并使后续对话不再加载该扩展。
10. WHILE Current User 的 Role 为 Member, THE System SHALL 允许只读查看已启用扩展的名称与类型，并拒绝新增、更新、覆盖、停用、删除。
11. IF Platform Admin 新增时名称与类型组合已存在, THE System SHALL 拒绝创建并返回冲突说明。
12. IF Platform Admin 按不存在的标识读取、更新或删除, THE System SHALL 返回未找到说明。
13. WHEN Platform Admin 新增、更新或覆盖一条扩展且保存成功, THE System SHALL 立即尝试加载该扩展，并返回已加载工具或指令数量，或返回可阅读的加载失败说明。
14. IF 某条已启用 MCP Server Config 在对话中连接失败, THE System SHALL 允许对话继续，并在 Observability Panel 记录该 MCP 连接失败说明。

### Requirement 5: Docker Compose 重建后扩展仍在

**User Story:** AS 部署人员, I want MCP / Skill / 插件的配置和安装产物放在宿主机卷上, so that 重建容器后不必重新配置。

#### Acceptance Criteria

1. THE System SHALL 将 Extension Store（配置记录、Skill Pack 文件、Plugin Pack 文件、stdio MCP 所需安装产物）写入 Host Volume。
2. WHEN 容器被 docker compose up 重建且 Host Volume 仍在, THE System SHALL 在启动后加载重建前已保存的 MCP Server Config、Skill Pack 与 Plugin Pack。
3. WHEN 容器重建完成且 Platform Admin 打开扩展列表, THE System SHALL 展示与重建前相同的名称、类型、启用状态。
4. WHEN 容器重建完成, THE System SHALL 在后续所有 User 的对话中继续加载重建前已启用的扩展。
5. THE System SHALL 将 LLM Profile、Qdrant Profile、Conversation 历史与 Trace 一并写入 Host Volume，使容器重建后上述数据仍可读取。

### Requirement 6: 智能体对话界面

**User Story:** AS Member, I want 在 PTDoc 里直接和两个智能体对话, so that 我不必离开文档工作区。

#### Acceptance Criteria

1. WHILE Current User 已登录, THE System SHALL 在主界面提供智能体对话入口，并允许在 Knowledge QA Agent 与 Markdown Writer Agent 之间切换。
2. WHEN Current User 发送一条消息, THE System SHALL 把当前 Conversation 的全部已保存轮次作为上下文发给模型，并以流式方式展示回复文本。
3. WHEN Current User 打开某一 Agent Scene, THE System SHALL 展示该 User 在该场景下已保存的 Conversation 列表，并允许继续某一 Conversation 或开启新 Conversation。
4. WHEN 一轮回复完成, THE System SHALL 将本轮用户消息、助手消息、Trace 标识写入该 Conversation。
5. WHEN Current User 删除一条属于自己的 Conversation, THE System SHALL 移除该 Conversation 的消息与 Trace，并保持 Workspace 文档不变。
6. WHEN Current User 在流式输出过程中点击停止, THE System SHALL 结束本轮生成，保留已收到的部分文本，将 Trace 标记为中断，并展示可阅读的中断说明。
7. IF 大模型流式响应在用户未点击停止时断开, THE System SHALL 保留已收到的部分文本，并展示可阅读的中断说明。

### Requirement 7: 对话内嵌 VoltAgent 可观测

**User Story:** AS Member, I want 在对话旁边看到本轮检索、工具调用和耗时, so that 我能判断回答依据是否有价值。

#### Acceptance Criteria

1. WHEN 一轮 Turn 开始, THE System SHALL 为该 Turn 创建一条 Trace 并与当前 Conversation 绑定。
2. WHEN Knowledge QA Agent 完成本轮检索, THE System SHALL 在 Observability Panel 展示每条 Retrieved Hit 的文档标识、标题或路径、相似度分数与片段摘要。
3. WHEN 智能体调用工具、MCP、Skill 或插件, THE System SHALL 在 Observability Panel 按时间顺序列出调用名称、输入摘要、输出摘要、成功或失败状态、耗时毫秒。
4. WHEN 一轮 Turn 结束, THE System SHALL 在 Observability Panel 展示模型名、输入 Token、输出 Token、总耗时毫秒、Trace 标识。
5. WHEN Current User 选中某一历史 Turn, THE System SHALL 在 Observability Panel 展示该 Turn 已保存的 Trace。
6. THE System SHALL 将 Trace 写入 Host Volume 上的可观测存储，使容器重建后仍可按 Conversation 回看。

### Requirement 8: 鉴权、隔离与密钥安全

**User Story:** AS Member, I want 我的模型密钥、Qdrant 配置和对话只属于我, so that 其他用户无法读取。

#### Acceptance Criteria

1. WHEN 请求访问智能体对话、扩展配置或可观测数据, THE System SHALL 使用与现有接口相同的 Session Cookie 或 Bearer API Token 识别 Current User。
2. WHEN Current User 列出 Conversation、Trace、LLM Profile 或 Qdrant Profile, THE System SHALL 仅返回属于该 User 的记录。
3. IF Current User 使用其他 User 的 Conversation、Trace、LLM Profile 或 Qdrant Profile 标识发起读写, THE System SHALL 拒绝该请求并返回权限不足说明。
4. WHILE Current User 的 Role 为 Platform Admin, THE System SHALL 保持其他 User 的对话内容、Trace、LLM Profile 与 Qdrant Profile 不可见。
5. IF Current User 的 Role 为 Member 且请求新增、更新、覆盖、停用或删除全局扩展, THE System SHALL 拒绝该请求并返回权限不足说明。
6. THE System SHALL 将 Qdrant API Key 与 MCP 连接密钥仅保存在服务端，避免接口响应返回明文。

### Requirement 9: 失败提示与边界

**User Story:** AS Member, I want 配置错误或远端失败时看到明确原因, so that 我知道该改哪一项配置。

#### Acceptance Criteria

1. IF LLM Profile 的 Base URL 或 API Key 无法完成一次模型调用, THE System SHALL 拒绝对话并返回可展示的大模型连接失败说明。
2. IF Qdrant Profile 的 URL、API Key 或 collection 无法完成一次检索, THE System SHALL 返回可展示的知识库连接失败说明，并完成本轮 Trace。
3. IF Platform Admin 新增或更新 MCP Server Config 时缺少名称或传输参数, THE System SHALL 拒绝保存并返回字段级错误说明。
4. IF Platform Admin 新增或覆盖的 Skill zip 根目录缺少 SKILL.md, THE System SHALL 拒绝保存并返回字段级错误说明，旧目录保持原样。
5. IF Markdown Writer Agent 请求写入的 doc_key 非法或与该 User 已有文档冲突, THE System SHALL 拒绝写入并返回可展示的路径错误说明。
6. THE System SHALL 将本阶段范围限定为对话、检索、引用插入、Handoff、Draft Diff 写回、扩展配置与可观测展示；知识库写入/增量索引、多人实时共编智能体、VoltOps 云端强制接入均不在本需求。

### Requirement 10: 问答交给编写的闭环

**User Story:** AS Member, I want 把本轮知识库问答连同命中材料交给编写智能体, so that 我能基于检索结果起草文档。

#### Acceptance Criteria

1. WHEN Current User 对一轮已完成的 Knowledge QA 回答执行 Handoff, THE System SHALL 让 Current User 选择目标为当前打开文档或另存新文档，然后创建一条 scene 为 writer 的新 Conversation，并把该轮用户问题、助手回答、Retrieved Hits 与目标选择写入该 Conversation 的起始上下文。
2. WHEN Markdown Writer Agent 接收到 Handoff Conversation 的第一条编写请求, THE System SHALL 把上述问题、回答与 Retrieved Hits 提供给该智能体。
3. WHEN Handoff 创建的编写 Conversation 产出草稿, THE System SHALL 走 Draft Diff 接受流程后才写入 Workspace。
4. WHILE Handoff 后的编写 Conversation 进行中, THE System SHALL 保持原知识库问答 Conversation 可继续提问，两条 Conversation 各自独立。
5. WHILE Markdown Writer Agent 的 Conversation 进行中且 Current User 已配置 Qdrant Profile, THE System SHALL 提供「补充检索」；默认编写上下文只用 Handoff 带来的材料或当前文档，不自动检索。
6. WHEN Current User 在编写 Conversation 中触发「补充检索」并提交查询文本, THE System SHALL 按该 User 的 Qdrant Profile 检索，把新 Retrieved Hits 追加进本轮上下文与 Observability Panel。
