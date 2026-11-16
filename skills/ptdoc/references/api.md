# PTDoc REST API 全量矩阵

认证：除「公开」标注外，全部接口都要登录——请求头 `Authorization: Bearer <token>`，
或携带 `ptdoc_session` Cookie（`POST /api/auth/login` 下发，默认 7 天，可用
`PTDOC_SESSION_TTL_DAYS` 调）。

所有 JSON 请求体经 `readJson` 解析；出错统一返回 `{"error":"<中文原因>"}` 加对应 HTTP
状态码（400 / 401 / 403 / 404 / 409 / 429 / 500）。数据按 `user_id` 隔离，访问别人的
记录一律表现为 404 或 403。

「验证」列：`✅` = 在独立实例（空库、临时端口、`/tmp` 副本）用 curl 实跑过并对照返回；
`⚠️ 未实测` = 依赖线上环境/七牛/LLM/Qdrant 等本机无法满足的条件，入参与返回取自源码。

---

## 1. 初始化与认证

源码：`src/server/auth-api.ts`（下文简写 `auth-api.ts`）

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/setup/status` | 公开 | — | `{initialized:boolean}` | `auth-api.ts:51` | ✅ |
| POST | `/api/setup` | 公开（仅首次） | `{username,password}` | `UserPublic`；已初始化则 409 | `auth-api.ts:54` | ✅ |
| POST | `/api/auth/register` | 公开 | `{username,password}` | `UserPublic`；未初始化 400，重名 409 | `auth-api.ts:57` | ✅ |
| POST | `/api/auth/login` | 公开 | `{username,password}` | `UserPublic` + `Set-Cookie`；失败 401，5 次锁 15 分钟→429 | `auth-api.ts:60` | ✅ |
| POST | `/api/auth/logout` | 会话 | — | `{ok:true}` | `auth-api.ts:63` | ✅ |
| GET | `/api/auth/me` | ✅ | — | `UserPublic` | `auth-api.ts:66` | ✅ |
| POST | `/api/auth/password` | ✅ | `{old_password,new_password}` | `{ok:true}`；旧密码错 401；改完旧会话全清并重发 Cookie | `auth-api.ts:70` | ✅ |
| POST | `/api/auth/token` | ✅ | `{token}`（16–64 位字母数字，**调用方指定**） | `{ok:true,has_api_token:true}` | `auth-api.ts:73` | ✅ |
| DELETE | `/api/auth/token` | ✅ | — | `{ok:true,has_api_token:false}` | `auth-api.ts:76` | ✅ |
| GET | `/api/admin/users` | 管理员 | — | `[{id,username,role,status,created_at}]` | `auth-api.ts:79` | ✅ |
| POST | `/api/admin/users/:id/role` | 管理员 | `{role:"admin"\|"member"}` | `{ok:true}` | `auth-api.ts:84` | ✅ |
| POST | `/api/admin/users/:id/status` | 管理员 | `{status:"active"\|"disabled"}`；停用会删该用户全部会话 | `{ok:true}` | `auth-api.ts:96` | ✅ |
| POST | `/api/admin/users/:id/reset-password` | 管理员 | `{password}` | `{ok:true}` | `auth-api.ts:109` | ✅ |

`UserPublic` = `{id, username, role, status, created_at, has_api_token}`。
用户名 `^[a-zA-Z0-9._-]{3,32}$`，密码 8–72 字符（`auth.ts:19,25`）。
管理员不能取消自己的 admin 角色、不能停用自己。

## 2. 文档

源码：`src/server/api.ts`

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/docs` | ✅ | `?q=` 可选（`LIKE %q%` 匹配 title/filename/content，最多 50）、`?space=<id\|name\|all>` | `DocSummary[]` | `api.ts:348` | ✅ |
| GET | `/api/docs/full` | ✅ | `?space=` 可选 | `DocRow[]`（含 `content` 与只读 `content_sha256`） | `api.ts:311` | ✅ |
| GET | `/api/docs/:id` | ✅ | 数字 id | `DocRow` + `content_sha256`；不存在 404 | `api.ts:341` | ✅ |
| POST | `/api/docs` | ✅ | `{doc_key,title?,filename?,content?,space_id?,folder_id?}`；同空间同 `doc_key` 即原地更新；跨空间撞名自动 `~2` | `{id,doc_key}`（回显最终 key） | `api.ts:301` | ✅ |
| POST | `/api/docs/:id/rename` | ✅ | `{new_key}`；级联更新 shares.doc_key | `{ok:true}` | `api.ts:331` | ✅ |
| DELETE | `/api/docs/:id` | ✅ | 数字 id（不吃 doc_key）；只删记录，不删七牛对象 | `{ok:true}` | `api.ts:336` | ✅ |
| POST | `/api/docs/:id/move` | ✅ | `{space_id?,folder_id?,before_id?/after_id?}`；跨空间撞名自动 `~2` | `{ok,space_id,folder_id,sort_order,doc_key}` | `api.ts:214` | ✅ |
| POST | `/api/docs/:id/reorder` | ✅ | `{before_id?,after_id?}` | `{ok:true}` | `api.ts:219` | ✅ |
| POST | `/api/docs/:id/snapshots` | ✅ | `{label?}`（旧接口，等价于 versions POST） | `{id}` | `api.ts:225` | ✅ |
| GET | `/api/docs/:id/snapshots` | ✅ | — | `[{id,doc_id,content,label,created_at}]` | `api.ts:229` | ✅ |
| POST | `/api/docs/:id/snapshots/:snapshotId/restore` | ✅ | — | `{ok:true}`；只回写正文 | `api.ts:233` | ✅ |
| DELETE | `/api/docs/:id/snapshots/:snapshotId` | ✅ | — | `{ok:true}` | `api.ts:237` | ✅ |
| POST | `/api/docs/:id/archive-path` | ✅ | `{archive_path}`；需该文档已有一个带 `html_url` 的分享，否则 400 `文档尚未归档` | `{ok:true}` | `api.ts:157` | ✅（含错误分支） |
| POST | `/api/docs/:id/qdrant-sync` | ✅ | — | 同步结果；文档未归档 400 | `api.ts:162` | ✅（错误分支） |
| GET | `/api/docs/export.zip` | ✅ | `?space=` 可选 | `application/zip`：全部 md + `INDEX.md` + `archive-urls.csv` | `api.ts:321` | ✅ |

### 文档版本（FR-22/24）

`:id` 同时接受**数字 id 或 URL 转义后的 doc_key**（`ops%2Fa.md`）。

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/docs/:id/versions` | ✅ | `?limit=`(1–200，默认 50)、`?cursor=`(上一页最后一条 id)、`?kind=auto\|manual` | `{items:[{id,doc_id,kind,label,size,sha256,sha256_short,created_at}], next_cursor}` | `api.ts:268` | ✅ |
| POST | `/api/docs/:id/versions` | ✅ | `{label?}` | `{id}` | `api.ts:268` | ✅ |
| GET | `/api/docs/:id/versions/:vid` | ✅ | — | `{id,kind,label,content,size,sha256,created_at}` | `api.ts:248` | ✅ |
| POST | `/api/docs/:id/versions/:vid/restore` | ✅ | — | `{ok,pre_restore_version_id}`；回滚前自动存 manual 版本 | `api.ts:242` | ✅ |
| DELETE | `/api/docs/:id/versions/:vid` | ✅ | — | `{ok:true}` | `api.ts:248` | ✅ |

**已知限制**：`doc_key` 当路径参数用时必须 URL 转义（`ops/a.md` → `ops%2Fa.md`）。裸斜杠会被
`hasBareDocKeySlash` 直接 400（`http.ts:58`，尾段白名单 `DOC_REF_TAILS_RE`），不再静默落到文档列表。
新增 `/api/docs/:id/*` 子路由时必须同步那个正则，否则新路由会被误判成裸斜杠。

`DocSummary` = `{id, doc_key, title, filename, updated_at, last_opened_at, space_id, folder_id, sort_order}`；
`DocRow` 再加 `user_id, content, created_at, archive_path, archive_token, qdrant_sync_share_id, qdrant_synced_at`。
`content_sha256` 是**只读且现算的**，不落表，供 ptdocctl 覆盖前比内容。
时间都是毫秒时间戳。

## 3. 归档

源码：`src/server/archive-api.ts`（匿名入口 `/a/*` 也在这里）

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/archive` | ✅ | `?q=`、`?space=`、`?include=all` | `{items:ArchiveItem[], entries:ArchiveEntry[], folders:Folder[]}` | `archive-api.ts:162` | ✅ |
| GET | `/api/archive/orphans` | ✅ | `?apply=1` 才真删；默认 dry-run | `{scanned,referenced,orphans,deleted?,warnings?,applied}` | `archive-api.ts:174` | ✅（真七牛桶） |
| POST | `/api/archive/folders` | ✅ | `{path}` | `{id,path,created_at}` | `api.ts:143` | ✅ |
| POST | `/api/archive/folders/rename` | ✅ | `{from,to}` | 重命名结果 | `api.ts:147` | ⚠️ 未实测 |
| DELETE | `/api/archive/folders` | ✅ | `?path=`；目录非空时 400 `文件夹内还有归档文档` | `{ok:true}` | `api.ts:151` | ✅（含错误分支） |
| POST | `/api/docs/:ref/archive` | ✅ | `{note?}`；`:ref` 接受 id 或转义 doc_key | `{id,version,token,public_url,md_url,html_url,unchanged,image_warnings}` | `archive-api.ts:221` | ✅ |
| GET | `/api/docs/:ref/archive` | ✅ | — | `{token,public_url,stale,current,history[]}` | `archive-api.ts:240` | ✅ |
| GET | `/api/docs/:ref/archive-status` | ✅ | — | `{stale,version,updated_at,token,public_url}` | `archive-api.ts:213` | ✅ |
| POST | `/api/docs/:ref/archive/rotate-token` | ✅ | — | `{token,public_url}`；旧链接立即失效 | `archive-api.ts:205` | ✅ |
| GET | `/a/:token` | 公开 | — | `text/html` 自包含归档页（当前 active 版本） | `archive-api.ts:144` | ✅ |
| GET | `/a/:token/md` | 公开 | `?download=1` 加附件头 | `text/markdown` | `archive-api.ts:126` | ✅ |
| GET | `/a/:token/v/:n` | ✅（历史版本只给登录用户） | — | `text/html` 该版本 | `archive-api.ts:110` | ✅ |

`ArchiveItem` = `{doc_id,doc_key,title,version,created_at,stale,token,history_count,note,space_id,space_name}`。
`ArchiveEntry` = `{id, doc_key, title, archive_path, share_id, html_url, md_url, created_at, stale, qdrant_sync, qdrant_synced_at}`。
`ArchiveArtifact`（current/history 元素）= `{id,version,status,created_at,note,md_url,html_url,md_size,html_size,source_content_sha256,version_url}`。

## 4. 分享

源码：`src/server/api.ts`（`/s/:id` 在 `api.ts:98`），删除与 `/a/*` 在 `archive-api.ts`

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/share` | ✅ | `{doc_key?,share_md,images?,md_url?,html_url?}` | `{id}` | `api.ts:355` | ✅ |
| GET | `/api/share` | ✅ | `?doc_key=` 可选 | `[{id,user_id,doc_key,md_url,html_url,created_at}]` | `api.ts:372` | ✅ |
| GET | `/api/share/:id` | ✅ | — | `{...share, images:[...]}`；不存在 404 | `api.ts:366` | ✅ |
| POST | `/api/share/:id/html` | ✅ | `{html_url}` | `{ok:true}` | `api.ts:360` | ✅ |
| DELETE | `/api/share/:id` | ✅ | `?purge=1` 时同时删七牛对象 | `{ok:true,deleted?}`；不带 purge 不影响七牛文件 | `archive-api.ts:258` | ✅ |
| GET | `/s/:id` | ✅（**要认证**，匿名 401） | — | `text/html`；文档已有归档 token 时 302 到 `/a/<token>` | `api.ts:98` | ✅ |

`images` 元素 = `{qiniu_key,url,mermaid_hash?}`。对外交付请用 `/a/<token>`：`/s/:id` 是旧路由，
恒需登录，前端已无入口生成它。

## 5. 媒体与上传

源码：`src/server/api.ts`（媒体）、`src/server/upload-api.ts`（上传）

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/media` | ✅ | `?q=`（filename/url 模糊）、`?source=direct\|mermaid\|share` | `MediaRow[]`（最多 500，按时间倒序） | `api.ts:382` | ✅ |
| DELETE | `/api/media/:id` | ✅ | — | `{ok:true}`；同时删七牛对象 | `api.ts:394` | ⚠️ 未实测（需七牛） |
| GET | `/api/upload` | ✅ | — | `{configured:boolean}` | `upload-api.ts:24` | ✅ |
| POST | `/api/upload` | ✅ | 裸二进制 body；头 `x-filename`、可选 `x-key-prefix`、`x-source: mermaid\|share\|direct` | `{key,url}` | `upload-api.ts:28` | ⚠️ 未实测（需七牛密钥；未配置时 400 `请先完成对象存储配置`） |

`MediaRow` = `{id,user_id,qiniu_key,url,filename,source,size,created_at}`（字段见 `db.ts` 的 `MediaRow`）。
上传用裸 body，不是 `multipart/form-data`。

## 6. Mermaid 图床缓存

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/mermaid-cache` | ✅ | — | `{<hash>: "<url>"}` | `api.ts:404` | ✅ |
| POST | `/api/mermaid-cache` | ✅ | `{hash,key,url}` | `{ok:true}` | `api.ts:407` | ✅ |

按内容 SHA-256 去重，同一图表不重复上传；配色/线型版本升级靠前端
`MERMAID_CACHE_VERSION` 自增淘汰旧缓存。

## 7. 存储配置（七牛）

源码：`src/server/api.ts`，实现 `src/server/storage.ts`

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/storage` | ✅ | — | `{access_key,bucket,domain,zone,private_bucket,url_ttl,secret_configured,verified}`（不回显 SecretKey） | `api.ts:121` | ✅ |
| POST | `/api/storage/test` | ✅ | 同 PUT 字段 | `{ok:true}`；连通性失败 400 带七牛原文 | `api.ts:124` | ✅（错误分支） |
| PUT | `/api/storage` | ✅ | `{access_key,secret_key?,bucket,domain,zone,private_bucket?,url_ttl?}` | 保存后的公开配置；`secret_key` 省略则沿用旧值 | `api.ts:136` | ✅（错误分支） |
| POST | `/api/storage/selfcheck` | ✅ | 同 PUT 字段（未保存也能测） | 私有桶自检：上传探针图 → 重签 → HEAD 的三态结果 | `api.ts:131` | ✅ |

`zone` 必须是合法七牛区域（如 `Zone_z0`）；`url_ttl` 60 秒–30 天，默认 3600。
SecretKey 用 `PTDOC_DATA_KEY` 做 AES-256-GCM 加密落库。成功分支需真实七牛密钥，
本机只验证了 `{"error":"七牛连通性校验失败（HTTP 401）：...\"BadToken\"..."}`。

## 8. 空间与目录（Space）

源码：`src/server/api.ts` / `db.ts`

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/spaces` | ✅ | — | `{spaces:[{id,user_id,name,is_default,sort_order,created_at}]}` | `api.ts:167` | ✅ |
| POST | `/api/spaces` | ✅ | `{name}` | 新空间 | `api.ts:170` | ✅ |
| POST | `/api/spaces/reorder` | ✅ | `{order:[id...]}` | `{ok:true}` | `api.ts:174` | ✅ |
| GET | `/api/spaces/:id/tree` | ✅ | — | 该空间的目录树 | `api.ts:178` | ✅ |
| POST | `/api/spaces/:id/folders` | ✅ | `{name,parent_id?}` | 新目录 | `api.ts:182` | ✅ |
| PATCH | `/api/spaces/:id` | ✅ | `{name}` 或 `{is_default:true}` | 改名的 `{ok}` / 转移默认标记的 `{ok,space_id}` | `api.ts:187` | ✅ |
| DELETE | `/api/spaces/:id` | ✅ | `?move_to=`（非空空间必须给） | `{ok:true}`；默认空间不可删 | `api.ts:196` | ✅ |
| POST | `/api/folders/:id/move` | ✅ | `{space_id?,parent_id?,before_id?/after_id?}` | `{ok:true}` | `api.ts:200` | ✅ |
| PATCH | `/api/folders/:id` | ✅ | `{name}` | `{ok:true}` | `api.ts:205` | ✅ |
| DELETE | `/api/folders/:id` | ✅ | — | `{ok:true}` | `api.ts:209` | ✅ |

**空间筛选参数**：`?space=` 三种取值——省略=全部空间（读接口向后兼容）、`all`=显式全部、数字 id 或空间名=该空间。
`doc_key` 在**每个空间内**唯一；不带 `space` 而跨空间重名 → 409。

## 9. 留存策略（FR-23）

| 方法 | 路径 | 认证 | 入参 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/api/settings/retention` | ✅ | — | `{snapshot_keep_count,snapshot_keep_days,snapshot_keep_min}` |
| PUT | `/api/settings/retention` | ✅ | 同上字段 | 保存后的策略 |

---

## 10. 智能体与扩展

源码：`src/server/agent-api.ts`

| 方法 | 路径 | 认证 | 入参 | 返回 | 源码位置 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/agents/llm` | ✅ | — | `{base_url,model,thinking_level,secret_configured}` | `agent-api.ts:168` | ✅ |
| PUT | `/api/agents/llm` | ✅ | `{base_url,model,api_key?,thinking_level?}` | 同上（不含密钥） | `agent-api.ts:177` | ⚠️ 未实测（需真实 LLM 端点） |
| GET | `/api/agents/qdrant` | ✅ | — | `{url,collection,vector_name,top_k,secret_configured}` | `agent-api.ts:191` | ✅ |
| PUT | `/api/agents/qdrant` | ✅ | `{url,collection,api_key?,vector_name?,top_k?}` | 同上 | `agent-api.ts:201` | ⚠️ 未实测（需真实 Qdrant） |
| GET | `/api/agents/extensions` | ✅ | — | 管理员全量，普通用户仅启用的摘要 | `agent-api.ts:221` | ✅ |
| GET | `/api/agents/conversations` | ✅ | `?scene=qa\|writer` | `Conversation[]` | `agent-api.ts:227` | ✅ |
| POST | `/api/agents/conversations` | ✅ | `{scene:"qa"\|"writer"}` | `{id,user_id,scene,title,created_at,updated_at}` | `agent-api.ts:232` | ✅ |
| GET | `/api/agents/conversations/:id` | ✅ | — | 会话 + `turns[]` | `agent-api.ts:239` | ⚠️ 未实测 |
| DELETE | `/api/agents/conversations/:id` | ✅ | — | `{ok:true}` | `agent-api.ts:246` | ✅ |
| POST | `/api/agents/conversations/:id/chat` | ✅ | `{input,doc_id?}`；SSE 流式；需先配 LLM（qa 场景还需 Qdrant） | `text/event-stream`；会话进行中再发则 `{queued:true}` | `agent-api.ts:252` | ⚠️ 未实测（需 LLM） |
| POST | `/api/agents/conversations/:id/turns/:turnId/retry` | ✅ | — | 重试该轮 | `agent-api.ts:258` | ⚠️ 未实测 |
| POST | `/api/agents/conversations/:id/stop` | ✅ | — | `{ok:true}` 中止进行中的生成 | `agent-api.ts:263` | ⚠️ 未实测 |
| POST | `/api/agents/conversations/:id/handoff` | ✅ | `{turn_id}` | `{writer_conversation_id}` | `agent-api.ts:270` | ⚠️ 未实测 |
| POST | `/api/agents/conversations/:id/apply-draft` | ✅ | `{content,mode:"replace-current"\|"create",doc_id?,doc_key?}` | `{id,doc_key}` | `agent-api.ts:292` | ⚠️ 未实测 |
| GET/POST | `/api/agents/conversations/:id/draft-diff` | ✅ | GET `?content=&target_doc_id=`；POST `{content,target_doc_id?}` | `{hunks:[{type,lines}]}` | `agent-api.ts:314` | ✅ |
| GET | `/api/agents/conversations/:id/turns/:turnId/trace` | ✅ | — | trace 行 + `hits[]` / `spans[]` | `agent-api.ts:336` | ⚠️ 未实测 |
| POST | `/api/agents/conversations/:id/retrieve` | ✅ | 检索参数；需 Qdrant | 检索命中 | `agent-api.ts:347` | ⚠️ 未实测（需 Qdrant） |
| GET | `/api/admin/extensions` | 管理员 | `?kind=&q=` | 扩展列表 | `agent-api.ts:115` | ✅ |
| GET | `/api/admin/extensions/:id` | 管理员 | — | 单条扩展 | `agent-api.ts:119` | ⚠️ 未实测 |
| DELETE | `/api/admin/extensions/:id` | 管理员 | — | `{ok:true}` | `agent-api.ts:123` | ⚠️ 未实测 |
| POST | `/api/admin/extensions/:id/enable` | 管理员 | — | 更新后的扩展 | `agent-api.ts:127` | ⚠️ 未实测 |
| POST | `/api/admin/extensions/:id/disable` | 管理员 | — | 更新后的扩展 | `agent-api.ts:129` | ⚠️ 未实测 |
| POST | `/api/admin/extensions/mcp` | 管理员 | `{name,url?,command?,args?,env?}` 等 | 新建的 MCP 扩展 | `agent-api.ts:132` | ⚠️ 未实测 |
| PUT | `/api/admin/extensions/mcp/:id` | 管理员 | 同上 | 更新后的扩展 | `agent-api.ts:135` | ⚠️ 未实测 |
| POST | `/api/admin/extensions/skills` | 管理员 | `multipart`：`name` + zip 文件 | 新建的 skill 扩展 | `agent-api.ts:140` | ⚠️ 未实测 |
| PUT | `/api/admin/extensions/skills/:id` | 管理员 | 同上 | 更新后的扩展 | `agent-api.ts:144` | ⚠️ 未实测 |
| POST | `/api/admin/extensions/plugins` | 管理员 | `multipart`：`name` + zip | 新建的 plugin 扩展 | `agent-api.ts:149` | ⚠️ 未实测 |
| PUT | `/api/admin/extensions/plugins/:id` | 管理员 | 同上 | 更新后的扩展 | `agent-api.ts:153` | ⚠️ 未实测 |

---

## 未实现 / 不存在的端点

以下在源码里没有，脚本里别写：

- 「按 doc_key 直接取文档」只存在于 `versions`/`archive` 这类子路由上（它们接受转义 doc_key）；
  单纯读一篇仍只有 `GET /api/docs/:id`（数字 id），先 `GET /api/docs` 拿 id。
- 分享页的公开访问控制开关；`/s/:id` 恒需要认证。
- 删除用户的接口（只有改角色、停用、重置密码）。
- 任何 `/api/docs/:id/export`（导出全站用 `GET /api/docs/export.zip`）、`/api/search`（搜索就是 `GET /api/docs?q=`）。
- 分页参数：列表接口都不支持 `limit`/`offset`（`/api/media` 硬上限 500，搜索上限 50）。

## 验证方法（可复现）

```bash
# 1) 独立实例：拷仓库到临时目录，自带 node_modules 软链与临时 .env（不改仓库 data/）
rsync -a --exclude node_modules --exclude .git --exclude data ./ /tmp/ptdoc-verify/
ln -s "$PWD/node_modules" /tmp/ptdoc-verify/node_modules
cd /tmp/ptdoc-verify && printf 'PTDOC_DATA_KEY=%s\n' \
  "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" > .env
PORT=5199 npx vite &          # PORT 必须走进程环境变量，.env 里的 PORT 不生效

# 2) 用 curl 按本文件顺序跑：setup → token → docs → snapshots → share → archive → agents
# 3) 清理：kill 实例，rm -rf /tmp/ptdoc-verify
```
