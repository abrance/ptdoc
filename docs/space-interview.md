# Grill Me Results

Generated: 2026-11-15T12:22:04.385Z

## Plan

(state was created by grill_record_turn; no plan recorded)

## Shared Understanding

Space 隔离已完成需求访谈（16 项决策）与数据层/API 实现（P1+P2，209 项单测通过）。剩余 UI（P3/P4）与 ptdocctl（P5）。

## Questions and Answers

### 1. FR-35（分享链接文案与可达性一致）代码已被归档 M1 整段删除，现网只有免登录的 /a/<token>。怎么处理？

**Recommended answer:** 标作废，不改代码

**User answer:** 先留着不处理

**Status:** resolved

**Notes:** FR-35 目标代码（三态徽标、/s/:id 复制回退、分享弹窗）已在 0e1733d 归档 M1 删除；本轮 S1 不动，SP 任务保留。

### 2. FR-34 真问题在「删文档不删归档对象」。删文档时怎么处理归档产物？

**Recommended answer:** 删前先删对象，失败不阻塞 + warnings

**User answer:** 删文档时只删记录，另给批量清理入口

**Status:** resolved

**Notes:** DELETE /api/docs/:id 语义不变；新增孤儿对象批量清理入口（扫桶内无引用 archive/* 对象）。

### 3. FR-28 归档页增强，做哪些？（草案列了 TOC/暗色/打印/窄屏四项）

**Recommended answer:** 四项全做

**User answer:** 只做 TOC + 暗色

**Status:** resolved

**Notes:** 打印与窄屏两项本轮不做，留到下一轮。

### 4. Space 在产品上是什么？这决定所有后续 UI 形态。

**Recommended answer:** 全局工作区（切换上下文）

**User answer:** 全局工作区（切换上下文）

**Status:** resolved

**Notes:** 决定：侧栏树、新建文档、归档、搜索默认只作用于当前空间；切空间=换上下文。

### 5. Space 切换入口放哪儿？（现在是一排 chips 挤在侧栏顶部）

**Recommended answer:** 侧栏顶部下拉

**User answer:** 侧栏顶部下拉

**Status:** resolved

**Notes:** 替换现有 chips；下拉内含当前空间名、切换列表、新建空间。

### 6. 切换空间后，哪些页面/能力跟着 Space 走？（可多选）

**Recommended answer:** 归档列表 + 全文搜索 + 智能体问答检索 + 媒体库

**User answer:** 归档列表, 全文搜索；默认选中当前空间作为筛选条件，可以取消条件，也可以选其他空间作为筛选条件。要求后端 API 都支持跨空间搜索和这些筛选条件。

**Status:** resolved

**Notes:** 关键追加要求：后端 API 必须支持跨空间查询与空间筛选参数，不能只在前端过滤。qa 检索与媒体库未列入跟随范围。

### 7. 真隔离后两个空间可各有 README.md。跨空间搬移、ptdocctl push 撞上同名时怎么办？

**Recommended answer:** 拒绝并提示改名

**User answer:** 自动加后缀 ~2

**Status:** resolved

**Notes:** 搬移与 ptdocctl push 撞名时自动生成 ~2；需把最终 doc_key 回显给用户。

### 8. 归档页 / 搜索的「空间筛选」做成什么控件？

**Recommended answer:** 单选 + 全部空间

**User answer:** 单选 + 全部空间

**Status:** resolved

**Notes:** 归档页/搜索用空间下拉：当前空间/全部空间/具体空间。单选。

### 9. 当前空间要不要写进 URL？

**Recommended answer:** 不进 URL，localStorage 记忆

**User answer:** 放 query 参数

**Status:** resolved

**Notes:** 刷新/分享可恢复；不改现有前端路由结构。

### 10. 你上一轮没选的两个：智能体问答检索、媒体库图床 —— 到底要不要跟 Space？

**Recommended answer:** 都保持全局

**User answer:** 都保持全局

**Status:** resolved

**Notes:** 问答检索与图床都不做空间隔离，避免问答搜不到其他空间知识、同一张图重复上传。

### 11. 默认空间（现在叫 default）怎么处理？

**Recommended answer:** 可改名 + 可转默认

**User answer:** 可改名 + 可转默认

**Status:** resolved

**Notes:** 默认空间可改名，且默认标记可转给其他空间；恒有一个默认且不可删。

### 12. 切空间那一刻，如果编辑器里已经打开着另一个空间的文档，怎么处理？

**Recommended answer:** 自动打开新空间的文档

**User answer:** 有未保存才拦，否则自动切（无改动时打开新空间首篇）

**Status:** resolved

**Notes:** 切空间：有未保存改动弹窗拦截；无改动直接切并打开新空间首篇文档。

### 13. ptdocctl（你唯一的写入自动化入口）怎么指定空间？

**Recommended answer:** 加 --space，不传用默认空间

**User answer:** 加 --space，不传用默认空间

**Status:** resolved

**Notes:** ptdocctl 加 --space；不传落默认空间，与现有行为兼容。输出需回显最终 doc_key（含 ~2 后缀）。

### 14. 归档页选「全部空间」时，列表怎么排？

**Recommended answer:** 按空间分组

**User answer:** 按空间分组

**Status:** resolved

**Notes:** 归档页「全部空间」按空间分组显示，行内不再重复空间名。

### 15. 真隔离后，API 只收到 doc_key（不带 space）时怎么解？

**Recommended answer:** 409 要求指定空间

**User answer:** 409 要求指定空间

**Status:** resolved

**Notes:** API 只给 doc_key 且跨空间命中多篇 → 409 要求带 ?space=，不静默选一个。

### 16. 现有文档（全在 default 空间）要不要做一次性拆分？

**Recommended answer:** 不拆，全留当前空间

**User answer:** 不拆，全留当前空间

**Status:** resolved

**Notes:** 存量文档全留当前默认空间，迁移只放宽索引，不做自动拆分。

## Agreed Decisions

- Space = 全局工作区：切空间换整个上下文（侧栏树、新建、归档、搜索范围）
- 切换入口：侧栏顶部下拉（替换现有 chips），含当前空间/列表/新建空间
- 归档列表与全文搜索跟空间走：单选下拉（当前空间/全部空间/具体空间）；后端 API 必须支持跨空间查询与筛选
- 归档页选「全部空间」时按空间分组显示
- 智能体问答检索与媒体库图床都保持全局，不做空间隔离
- 当前空间写进 URL query（?space=<id>），刷新与分享可恢复
- 切空间：有未保存改动才弹窗拦截；无改动直接切并打开新空间首篇文档
- 默认空间可改名 + 默认标记可转给其他空间；恒有且仅有一个默认，不可删
- 跨空间搬移与 ptdocctl push 撞名：自动加 ~2 / ~3 后缀，并回显最终 doc_key
- ptdocctl 加 --space；不传则落默认空间（兼容现有行为）
- API 只给 doc_key 且跨空间命中多篇 → 409，要求带 space 参数
- 存量文档不拆分，全部留在当前默认空间
- doc_key 唯一性改为 (user_id, space_id, doc_key)；archive_path 与 shares 活跃键同步加空间维度
- shares 与归档列表按 (space_id, doc_key) 归并，两空间可各有同名归档

## Open Risks

- docs 表重建迁移在生产库上需先备份，且必须幂等；已加 VACUUM INTO 备份与 schema_meta 标记，但尚未在真实生产库上跑过
- 跨空间重名的旧调用（ptdocctl、skills 里的 curl 示例）在不带 space 时可能开始收到 409
- 空间内同名归档路径现在允许并存，归档树可能出现两个同名路径
- FR-26 私有桶真机验收仍未做（缺真私有桶）

## Next Decision Needed

UI 阶段（P3/P4）细节：侧栏下拉的默认空间标记与删除入口形态；P5 ptdocctl --space 的报错文案
