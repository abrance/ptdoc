# PTDoc 容器镜像：多阶段构建，Node 24（node:sqlite 与 TS 直接执行都需要）。
#
# 运行方式：容器内用 `vite preview` 提供编辑器页面 + /api/*（上传/文档/分享）接口，
# 与本地 `npm run preview` 行为一致；SQLite 库放在挂载卷 /app/data（见 compose）。
# dist-site 静态站点依赖运行时数据库中的文档，不在镜像内预生成，用 `make site` 按需生成。

# ─── 构建阶段：装依赖 + 构建前端 ──────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# 先只复制依赖清单，利用 Docker 层缓存（源码改动时不重装依赖）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并构建
COPY . .

# VITE_* 构建参数：站点标题 / 默认文档（构建时注入前端，可用 compose 的 .env 覆盖）
ARG VITE_SITE_TITLE
ARG VITE_DEFAULT_DOC
ENV VITE_SITE_TITLE=${VITE_SITE_TITLE} VITE_DEFAULT_DOC=${VITE_DEFAULT_DOC}

# vite.config.ts 加载时会 initDB()（生成空的 data/ptdoc.db）与 initQiniu()（缺密钥静默跳过），
# 因此没有 .env 也能完成构建；data/ 已被 .dockerignore 排除，不会带进镜像。
RUN npm run build

# ─── 运行阶段 ─────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# 运行时需要完整依赖：vite 在 devDependencies（preview 服务器），qiniu/marked 等为业务依赖
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

# 前端产物 + preview 服务端所需源码（vite.config 的中间件、make site 用的 build-site）
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/vite.config.ts ./vite.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# 默认监听端口（vite preview，与 .env 的 PREVIEW_PORT 约定一致）
EXPOSE 4173
CMD npx vite preview --host 0.0.0.0 --port "${PREVIEW_PORT:-4173}"
