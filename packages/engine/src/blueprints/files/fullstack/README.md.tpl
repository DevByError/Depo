# __DEPO_NAME__

__DEPO_DESCRIPTION__

A full stack app started from Depo's **Full stack app** blueprint: a FastAPI service in `api/` and a
React web app in `web/`. In development the web app's server passes every `/api` call to the API,
so the browser talks to one address and needs no CORS setup.

## What is inside

- `api/`: sign-up and sign-in with JWT, admin and user roles on every route, an example resource
  (`projects`) with CRUD, validation, pagination and filters, one JSON error format, request logs,
  a health check, SQLite out of the box and ready for PostgreSQL, a seed command, pytest tests
- `web/`: Vite, React, TypeScript and Tailwind CSS with sign-in and sign-up, a protected layout,
  the projects list, detail and form screens with loading, empty and error states, an admin Users
  screen, light and dark themes, Vitest tests

Each folder has its own README with the details.

## Requirements

Python 3.10 or newer and Node.js 20 or newer.

## Run it

| Windows | macOS and Linux |
| --- | --- |
| `run.cmd` or `powershell -ExecutionPolicy Bypass -File run.ps1` | `./run.sh` |

This starts the API on http://127.0.0.1:8000 (on Windows in its own window) and the web app on
http://127.0.0.1:5173. Open the web app. To create the first admin, set `ADMIN_EMAIL` and
`ADMIN_PASSWORD` in `api/.env` (made on the first run) and start again.

## Test it

| Windows | macOS and Linux |
| --- | --- |
| `test.cmd` or `powershell -ExecutionPolicy Bypass -File test.ps1` | `./test.sh` |

This runs the API's pytest suite, then the web app's type check and Vitest tests.

## Add a feature end to end

1. API: a migration step, then schema, repository, service and routes copied from `projects`, with
   its permissions in `api/app/core/security.py` and tests in `api/tests/`.
2. Web: `web/src/features/<name>/api.ts` with the same shapes, then the screens and their routes in
   `web/src/App.tsx`, with a test for the list.
3. Run `test.cmd` (or `./test.sh`).
