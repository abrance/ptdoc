# PTDoc 构建 / 部署辅助
#
# 常用：
#   make up              构建镜像并后台启动（服务器上一条命令跑起来）
#   make site            在容器内重新生成静态站点 → ./dist-site
#   make deploy-site     把静态站点 rsync 到指定服务器
#   make logs / down     查看日志 / 停止

COMPOSE  := docker compose -f deploy/docker-compose/docker-compose.yml
SITE     ?=

.PHONY: help build up down restart logs ps exec site deploy deploy-site

help: ## 显示可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

build: ## 构建镜像（不启动）
	$(COMPOSE) build

up: ## 构建并后台启动（一键部署）
	$(COMPOSE) up -d --build

down: ## 停止并移除容器（data/ 数据保留）
	$(COMPOSE) down

restart: ## 重启服务（代码更新后常用）
	$(COMPOSE) restart

logs: ## 跟随容器日志
	$(COMPOSE) logs -f

ps: ## 查看服务状态
	$(COMPOSE) ps

exec: ## 进入容器终端
	$(COMPOSE) exec ptdoc sh

site: ## 在容器内重新生成静态站点到 ./dist-site
	$(COMPOSE) exec ptdoc npm run build-site

deploy: up ## 服务器上一键部署（构建 + 启动）

deploy-site: ## 同步静态站点到服务器：make deploy-site SITE=user@host:/var/www/ptdoc
	@test -n "$(SITE)" || (echo "用法：make deploy-site SITE=user@host:/path/to/site"; exit 1)
	rsync -avz --delete dist-site/ $(SITE)/
