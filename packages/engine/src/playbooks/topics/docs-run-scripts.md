---
title: README, run scripts and project docs
summary: A README that works on a fresh machine, one-command run.cmd and run.sh, .env.example, API and architecture docs, changelog, troubleshooting.
agents: devops-docs, project-management, backend, frontend, coder
triggers: readme, docs, documentation, run script, run.cmd, run.sh, setup, install guide, changelog, onboarding, getting started
---
# README, run scripts and project docs

## README.md template
```markdown
# Clinic Booking

Book appointments online. Patients book and manage visits; reception sees the day calendar; admins manage doctors, staff and roles.

## Requirements
- Python 3.12+, Node.js 22+ (or Docker Desktop for everything)
- PostgreSQL 17 (started by docker compose, or a local install)

## Quick start (Windows)
    run.cmd
macOS / Linux:
    ./run.sh
Then open http://localhost:5173. API docs: http://localhost:8000/docs

Demo accounts (created by the seed script): admin@example.com and patient@example.com,
password from DEMO_PASSWORD in .env (default shown once in the console).

## Configuration
Copy `.env.example` to `.env` and adjust. | Variable | Purpose | Example |

## Tests
    cd backend && python -m pytest -q
    cd frontend && npm test

## Project layout
    backend/   FastAPI app (app/routers, app/services, app/models), Alembic migrations, tests
    frontend/  React + Vite app (src/features, src/components/ui)
    docs/      architecture notes, diagrams, API guide

## Troubleshooting
- Port 8000 in use: `netstat -ano | findstr :8000` then `taskkill /PID <pid> /F`, or set API_PORT.
- `psycopg` cannot connect: is the db container healthy? `docker compose ps`.
```
Write what is true: run every command before documenting it. Keep it short; link to docs/ for depth.

## run.cmd (Windows, one command)
```bat
@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul || (echo Python 3.12+ is required: https://www.python.org/downloads/ & exit /b 1)
where npm >nul 2>nul || (echo Node.js 22+ is required: https://nodejs.org/ & exit /b 1)

if not exist .env copy .env.example .env >nul

rem Backend: virtual environment, dependencies, migrations, seed
if not exist backend\.venv python -m venv backend\.venv
call backend\.venv\Scripts\activate.bat
pip install -q -r backend\requirements.txt || exit /b 1
pushd backend
alembic upgrade head || (popd & exit /b 1)
python -m app.seed
popd

rem Frontend dependencies
if not exist frontend\node_modules (pushd frontend & call npm install & popd)

rem Start both; each gets its own window
start "API" cmd /k "cd /d %~dp0backend && .venv\Scripts\python -m uvicorn app.main:app --reload --port 8000"
start "Web" cmd /k "cd /d %~dp0frontend && npm run dev"
echo API: http://localhost:8000/docs   Web: http://localhost:5173
endlocal
```
Notes: `call` is required for `.bat`/`.cmd` scripts like `activate.bat` and `npm`, or the script stops after them; `start "title" cmd /k` runs processes in parallel windows; `%~dp0` is the script's folder; the seed script must be idempotent (skip when data exists).

## run.sh (macOS and Linux)
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v python3 >/dev/null || { echo "Python 3.12+ is required"; exit 1; }
command -v npm >/dev/null || { echo "Node.js 22+ is required"; exit 1; }
[ -f .env ] || cp .env.example .env
[ -d backend/.venv ] || python3 -m venv backend/.venv
backend/.venv/bin/pip install -q -r backend/requirements.txt
(cd backend && .venv/bin/alembic upgrade head && .venv/bin/python -m app.seed)
[ -d frontend/node_modules ] || (cd frontend && npm install)
(cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000) &
API_PID=$!
trap 'kill $API_PID' EXIT
cd frontend && npm run dev
```
Mark it executable (`git update-index --chmod=+x run.sh`) and keep LF line endings. With Docker, both scripts can simply run `docker compose up --build`.

## .env.example
```
# Backend
DATABASE_URL=postgresql+psycopg://app:app_dev_only@localhost:5432/app
JWT_SECRET=change-me-to-a-random-string-of-at-least-32-characters
ACCESS_TOKEN_MINUTES=15
CORS_ORIGINS=http://localhost:5173
DEMO_PASSWORD=
# Frontend (public: visible to every user, never put secrets here)
VITE_API_URL=http://localhost:8000
```
Every variable the code reads appears here with a comment; `.env` is in `.gitignore`.

## Other docs
- docs/API.md: authentication, error format, pagination, a few curl examples; link to `/docs` for the full OpenAPI reference.
- docs/ARCHITECTURE.md: components, data flow, key decisions with reasons (link decisions.md), diagrams from docs/diagrams.
- CHANGELOG.md in "Keep a Changelog" style: Added, Changed, Fixed, Security, per version or date.
- docs/DEPLOYMENT.md when deployment is in scope: environment variables for production, migrations, backups and restore, health checks.

## Checks before handing over
Clone into a fresh folder (or delete .venv and node_modules), run the script, open the app, sign in with the demo account, run the tests. Fix the docs until this works without guessing.
