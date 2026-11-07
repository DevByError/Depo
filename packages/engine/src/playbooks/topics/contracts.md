---
title: Contracts between layers: typed clients, environment, CORS, auth wiring
summary: Generating typed clients from OpenAPI, keeping the spec in sync, environment variables, CORS and cookies, wiring the auth flow end to end, contract tests.
agents: integration, frontend, backend, testing, coder
triggers: integration, contract, contracts, typed client, openapi client, sdk, cors, env, environment variables, .env, wiring, monorepo, full stack, fullstack
---
# Contracts between layers: typed clients, environment, CORS, auth wiring

## One source of truth for the API
- The OpenAPI document is the contract. Either write `openapi.yaml` first and implement it, or generate it from code (FastAPI `/openapi.json`, NestJS Swagger, Fastify swagger) and commit the exported file so changes show up in diffs.
- Export script example (FastAPI): `python -c "import json; from app.main import app; print(json.dumps(app.openapi(), indent=2))" > openapi.json`.
- CI check: regenerate and fail if the committed spec differs (`git diff --exit-code openapi.json`).

## Typed clients
TypeScript with openapi-typescript and openapi-fetch (small, no runtime codegen):
```
npx openapi-typescript ../backend/openapi.json -o src/api/schema.d.ts
```
```ts
import createClient from "openapi-fetch";
import type { paths } from "./schema";

export const client = createClient<paths>({ baseUrl: import.meta.env.VITE_API_URL ?? "", credentials: "include" });

const { data, error } = await client.GET("/api/v1/bookings", { params: { query: { limit: 20, offset: 0 } } });
if (error) throw toApiError(error);      // one mapping for the problem+json format
```
Alternatives: orval (generates TanStack Query hooks), `openapi-python-client` for Python consumers. Add the generate command to package.json (`"gen:api": "openapi-typescript ..."`) and run it whenever the API changes.

When generation is not possible, define shared types in one place (a `shared` package in a TypeScript monorepo, Zod schemas imported by both sides) and add a contract test.

## Environment variables
- Every variable read anywhere appears in `.env.example` with a comment and a safe placeholder.
- Validate at startup (pydantic-settings, Zod `parse(process.env)`, NestJS ConfigModule `validate`) and fail with the list of missing names.
- Public frontend variables (`VITE_`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_`) are compiled into the bundle and readable by anyone: base URLs and feature flags only, never secrets.
- Name ports and URLs consistently across services (`API_PORT=8000`, `VITE_API_URL=http://localhost:8000`) and use the same names in docker compose, run scripts and the README.

## CORS and cookies
- Best in development: same origin through a proxy (Vite `server.proxy`, Next.js rewrites), so no CORS and cookies just work.
- Cross-origin: allow explicit origins only, with credentials when cookies are used:
  - FastAPI: `CORSMiddleware(allow_origins=settings.cors_origins, allow_credentials=True, ...)`
  - Express: `cors({ origin: ["http://localhost:5173"], credentials: true })`
  - The browser must send `credentials: "include"`.
- Cross-site cookies need `SameSite=None; Secure` (HTTPS); on localhost different ports are the same site, so `SameSite=Lax` works across `localhost:5173` and `localhost:8000`.
- Never combine `Access-Control-Allow-Origin: *` with credentials (browsers reject it and it signals a misconfiguration).

## Wiring the auth flow end to end
1. Login: the API sets the refresh cookie (HttpOnly) and returns a short access token; the client keeps the access token in memory.
2. Requests: the client adds `Authorization: Bearer <token>`; on 401 it calls `/auth/refresh` once (deduplicate concurrent refreshes with a shared promise), retries the request, and on a second 401 sends the user to sign in.
3. Startup: the client calls `/auth/refresh` or `/me` to restore the session after a page reload.
4. Logout: call `/auth/logout` (revokes the refresh token, clears the cookie) and clear client caches (`queryClient.clear()`).
5. Permissions: `/me` returns the user's permissions for permission-aware UI.
Prove it with one automated test (API level or Playwright): login, protected call, refresh, logout, then a 401.

## Contract tests
- Schemathesis generates requests from the spec and checks responses: `schemathesis run http://127.0.0.1:8000/openapi.json --checks all` (point it at a test database; add auth headers with `-H`).
- Or targeted tests per endpoint asserting status codes and response shapes against the schema (`jsonschema` in Python, Ajv or Zod in TypeScript).
- Frontend: MSW handlers typed with the generated `paths` types, so a contract change breaks the frontend tests at compile time.

## Decisions to record
JSON casing, date format, pagination shape, error format, auth transport (cookie or header), API version prefix. Write them to decisions.md once; every layer follows them.
