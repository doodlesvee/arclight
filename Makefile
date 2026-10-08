# Everything runs in Docker; `make` is a thin wrapper over docker compose.
# Run `make` with no arguments to see the commands.

# Starting through this script also tells the app this machine's wifi address,
# so Settings can show the URL to open on a phone. Harmless if it finds none.
LAN := sh docker/with-lan-host.sh

COMPOSE := docker compose -f docker/docker-compose.yml

# Development: the source folders are mounted into the containers and the app
# reloads on edit.
DEV := $(COMPOSE) -f docker/docker-compose.dev.yml

.DEFAULT_GOAL := help
.PHONY: help up build down restart logs ps shell dev dev-down reset

help: ## Show this list
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  make %-10s %s\n", $$1, $$2}'

up: ## Build if needed and start the app on http://localhost:3000
	$(LAN) $(COMPOSE) up -d --build
	@echo "Running at http://localhost:$${APP_PORT:-3000}"

build: ## Rebuild the image from scratch, ignoring the cache
	$(COMPOSE) build --no-cache

down: ## Stop the app (your library data is kept)
	$(COMPOSE) down --remove-orphans

restart: down up ## Stop, then start again

logs: ## Follow the app's log output (Ctrl-C to stop)
	$(COMPOSE) logs -f --tail=100 app

ps: ## Show what is running
	$(COMPOSE) ps

shell: ## Open a shell inside the app container
	$(COMPOSE) exec app sh

dev: ## Start in development mode (live reload) on http://localhost:5173
	$(LAN) $(DEV) up -d --build

dev-down: ## Stop development mode
	$(DEV) down --remove-orphans

reset: ## DELETE the database and generated thumbnails, then stop (asks first)
	@if [ "$(YES)" != "1" ]; then \
		printf "This deletes the database and all generated thumbnails. Your video files are not touched.\nType 'yes' to continue: "; \
		read answer; [ "$$answer" = "yes" ] || { echo "Cancelled."; exit 1; }; \
	fi
	$(COMPOSE) down --volumes --remove-orphans
