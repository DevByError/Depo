# __DEPO_NAME__

__DEPO_DESCRIPTION__

A web app built with Vite, React, TypeScript and Tailwind CSS, started from Depo's **React web app**
blueprint.

## What is inside

- Sign-in and sign-up screens, a session kept across reloads, and a protected layout with navigation
- `projects`, a complete example: a list with search, status filter, sorting and pages, a detail
  screen, and one form for create and edit, each with loading, empty and error states
- An admin-only Users screen to change roles (hidden from other users; the API checks too)
- A typed API client with timeouts and the API's error format turned into field messages
- Accessible components: labels, error messages tied to their fields, visible focus, keyboard use,
  a skip link, and light and dark themes from one set of colour tokens
- Vitest tests for the API client, the sign-in screen and the projects list

## The API it talks to

The app calls `/api/...` on its own address; in development Vite passes those calls to
`http://127.0.0.1:8000` (set `API_PROXY_TARGET` to change it). It expects the API of Depo's
**FastAPI service** blueprint: `POST /api/auth/login`, `POST /api/auth/signup`, `GET /api/auth/me`,
`/api/projects` and `/api/users`, with errors as `{"error": {"code", "message", "details"}}`.
To call an API on another address in production, set `VITE_API_URL` when you build.

## Requirements

Node.js 20 or newer (npm comes with it). Bun works too.

## Run it

| Windows | macOS and Linux |
| --- | --- |
| `run.cmd` or `powershell -ExecutionPolicy Bypass -File run.ps1` | `./run.sh` |

The first run installs the packages, then the app opens on http://127.0.0.1:5173.
By hand: `npm install`, then `npm run dev`.

## Test it

| Windows | macOS and Linux |
| --- | --- |
| `run.cmd test` | `./run.sh test` |

By hand: `npm run typecheck` and `npm test`. `npm run build` makes the production files in `dist/`.

## Folder layout

```
src/
  App.tsx              every screen and its address
  main.tsx             starts the app and applies the theme
  styles.css           Tailwind and the colour tokens (light and dark)
  lib/                 API client, session, auth, theme, data loading
  components/ui/       Button, fields, loading, empty and error states
  components/layout/   the signed-in frame, route guard, theme toggle
  features/<name>/     one folder per area: api.ts, screens, tests
  pages/               screens that belong to no area (not found)
```

## Add a screen for a new resource

1. Copy `src/features/projects/api.ts` and change the types and paths to the new endpoints.
2. Copy the list, detail and form screens; keep the loading, empty and error states.
3. Add the routes in `src/App.tsx` and a link in `components/layout/AppLayout.tsx`.
4. Copy `ProjectsPage.test.tsx` for the new list. Run `npm run typecheck` and `npm test`.
