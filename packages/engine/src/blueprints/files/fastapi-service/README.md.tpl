# __DEPO_NAME__

__DEPO_DESCRIPTION__

A FastAPI service with accounts, roles and a complete example resource, started from Depo's
**FastAPI service** blueprint. It runs on SQLite out of the box and is ready for PostgreSQL.

## What is inside

- Sign-up and sign-in with JWT access tokens, passwords hashed with scrypt, failed sign-ins rate limited
- Roles (`user`, `admin`) checked by a dependency on every route, deny by default
- `projects`, an example resource: create, read, update, delete, validation, pagination, filters, search, sorting
- One JSON error format, request logging with request ids, a health check at `/api/health`
- Settings from the environment (`.env`), numbered migrations, a seed command for the first admin
- pytest tests for sign-in, roles, CRUD, validation and pagination

## Requirements

Python 3.10 or newer. On Windows, tick "Add python.exe to PATH" when you install it.

## Run it

| Windows | macOS and Linux |
| --- | --- |
| `run.cmd` or `powershell -ExecutionPolicy Bypass -File run.ps1` | `./run.sh` |

The first run creates `.venv`, installs the packages, copies `.env.example` to `.env`, creates the
first admin when `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set in `.env`, and starts the API on
http://127.0.0.1:8000. The interactive docs are at http://127.0.0.1:8000/docs. Set `PORT` to use
another port.

## Test it

| Windows | macOS and Linux |
| --- | --- |
| `run.cmd test` | `./run.sh test` |

By hand: `python -m pip install -r requirements-dev.txt`, then `python -m pytest -q`.

## API

| Method and path | Who may call it |
| --- | --- |
| `GET /api/health` | anyone |
| `POST /api/auth/signup`, `POST /api/auth/login` | anyone |
| `GET /api/auth/me` | signed in |
| `GET /api/projects?page=1&page_size=20&status=active&q=site&sort=-created_at` | signed in (own projects; admins see all) |
| `POST /api/projects`, `GET/PATCH/DELETE /api/projects/{id}` | signed in, own projects (admins: any) |
| `GET /api/users`, `PATCH /api/users/{id}/role` | admins |

Send the token as `Authorization: Bearer <access_token>`. Errors always look like
`{"error": {"code": "validation_error", "message": "...", "details": [{"field": "name", "message": "..."}]}}`.

## Folder layout

```
app/
  main.py            builds the app: routers, errors, logging, CORS
  core/              settings, errors, JWT and roles, passwords, rate limit, request log
  db/                database layer (SQLite or PostgreSQL) and numbered migrations
  schemas/           Pydantic models: what each route accepts and returns
  repositories/      SQL only
  services/          business rules and permission checks
  api/routes/        HTTP only: one file per resource
  seed.py            python -m app.seed creates the first admin
tests/               pytest, one file per area
```

## Add a resource

1. Add a migration step at the end of `app/db/migrations.py` (never edit a step that has run).
2. Copy the `projects` files in `schemas/`, `repositories/`, `services/` and `api/routes/`, and rename.
3. Add its permissions to `POLICY` in `app/core/security.py` and guard each route with `Depends(require("thing:action"))`.
4. Register the router in `app/main.py`.
5. Copy `tests/test_projects.py`: CRUD, 422, 404, ownership, pagination. Run `python -m pytest -q`.

## Production

- Set `APP_ENV=production` and a random `JWT_SECRET` of at least 32 characters. The docs page turns off.
- PostgreSQL: `pip install "psycopg[binary]"` and set `DATABASE_URL=postgresql://user:password@host:5432/db`.
- Docker: `docker build -t __DEPO_SLUG__ .` then `docker run -p 8000:8000 -e JWT_SECRET=... __DEPO_SLUG__`.
- The sign-in rate limit is kept in memory: run one worker, or move it to Redis.
