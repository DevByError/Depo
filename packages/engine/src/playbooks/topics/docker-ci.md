---
title: Docker, docker compose and GitHub Actions
summary: Multi-stage Dockerfiles for Python and Node, .dockerignore, compose with health checks and volumes, CI workflows with caching and services.
agents: devops-docs, backend, security, testing, coder
triggers: docker, dockerfile, container, containers, compose, docker-compose, ci, github actions, workflow, pipeline, deploy, deployment, devops
---
# Docker, docker compose and GitHub Actions

## Python API Dockerfile
```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

FROM base AS deps
COPY requirements.txt .
RUN pip install --prefix=/install -r requirements.txt

FROM base AS runtime
RUN useradd --create-home --uid 10001 app
COPY --from=deps /install /usr/local
COPY --chown=app:app . .
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8000/health'); sys.exit(0)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## Node app Dockerfile
```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```
Next.js: set `output: "standalone"` and copy `.next/standalone`, `.next/static` and `public`. A Vite SPA builds to `dist/` and is served by nginx (`nginx:alpine`, copy `dist` to `/usr/share/nginx/html`, add an SPA fallback to `index.html`).

## .dockerignore
```
node_modules
.venv
__pycache__
.git
.env
*.log
dist
coverage
```
Keeps images small and keeps secrets out of the build context.

## docker-compose.yml for local development
```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-app_dev_only}
      POSTGRES_DB: app
    ports: ["127.0.0.1:5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 10
  api:
    build: ./backend
    env_file: ./backend/.env
    environment:
      DATABASE_URL: postgresql+psycopg://app:${POSTGRES_PASSWORD:-app_dev_only}@db:5432/app
    ports: ["127.0.0.1:8000:8000"]
    depends_on:
      db: { condition: service_healthy }
  web:
    build: ./frontend
    ports: ["127.0.0.1:5173:80"]
    depends_on: [api]
volumes:
  pgdata:
```
- Bind ports to 127.0.0.1 so the database is not exposed on the network.
- Inside compose, services reach each other by service name (`db`), not localhost.
- Migrations: run them in the API's start command (`alembic upgrade head && uvicorn ...`) or a one-off `migrate` service.
- `docker compose up -d --build`, `docker compose logs -f api`, `docker compose down` (add `-v` to delete data).
- The building block `compose-postgres` provides a ready database service.
- Windows: Docker Desktop with the WSL 2 backend; keep `.sh` files with LF endings (`.gitattributes`: `*.sh text eol=lf`), or containers fail with `/bin/sh^M` errors.

## GitHub Actions CI
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app_test }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U app" --health-interval 5s --health-timeout 3s --health-retries 10
    defaults: { run: { working-directory: backend } }
    env:
      DATABASE_URL: postgresql+psycopg://app:app@localhost:5432/app_test
      JWT_SECRET: ci-only-secret-at-least-32-characters-long
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12", cache: pip, cache-dependency-path: backend/requirements*.txt }
      - run: pip install -r requirements.txt -r requirements-dev.txt
      - run: ruff check .
      - run: alembic upgrade head
      - run: pytest -q
  frontend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: frontend/package-lock.json }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck --if-present
      - run: npm test -- --run
      - run: npm run build
```
- Least privilege (`permissions: contents: read`); pin actions to a major version or, stricter, a commit SHA.
- Never print secrets; repository secrets go through `${{ secrets.NAME }}` and are not available to pull requests from forks.
- Add a Windows job (`runs-on: windows-latest`) when the project promises Windows support for its scripts.
- End-to-end tests in CI: `npx playwright install --with-deps chromium`, start the app through Playwright's `webServer`, upload the report as an artifact on failure.
