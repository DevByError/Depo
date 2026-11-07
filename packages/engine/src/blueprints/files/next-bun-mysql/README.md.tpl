# __DEPO_NAME__

__DEPO_DESCRIPTION__

A Next.js web app in `fe/` and a Bun + TypeScript API in `be/` with MySQL (or MariaDB). Sign up,
sign in and sign out already work, with tests.

## Run it

1. Install: `cd be && bun install`, then `cd fe && bun install`.
2. Database (optional for a first try): copy `be/.env.example` to `be/.env` and set `DATABASE_URL`,
   for example `mysql://app:app@127.0.0.1:3306/__DEPO_SLUG__`. Then, in `be/`:
   `bun run db:migrate` (creates the database and tables) and `bun run db:seed` (demo accounts).
   Without `DATABASE_URL` the API keeps users in memory, lost when it stops.
3. Start both: `run.cmd` on Windows, `./run.sh` on macOS and Linux. Or by hand: `cd be && bun run dev`
   (API on http://127.0.0.1:4000) and `cd fe && bun run dev` (web app on http://localhost:3000).

Demo accounts after seeding: `demo@example.com` / `demo12345`, `ada@example.com` / `ada12345`,
`alan@example.com` / `alan12345`.

## Test it

`test.cmd` (Windows) or `./test.sh`: the API's tests and types (`cd be && bun test && bun run typecheck`),
then the web app's (`cd fe && bun test lib && bun run typecheck`).

## How it fits together

- The browser only talks to the web app. Next passes `/api/...` to the API (`BACKEND_URL`, default
  http://127.0.0.1:4000), so the session cookie stays on one site and no CORS setup is needed.
- Sessions: a random token in an HttpOnly, SameSite=Lax cookie (Secure in production). The database
  stores only its SHA-256. Passwords are hashed with Argon2id.
- API routes are listed in `be/src/app.ts`; each feature has its own folder like `be/src/auth/`.
  Data goes through the `Store` interface (`be/src/db/store.ts`), with a MySQL version and an
  in-memory one for tests. New tables go at the end of `be/src/db/schema.sql`.
- Errors always look like `{"error": {"code", "message", "fields"}}`; the web app shows `fields`
  next to the inputs.
- The look comes from the tokens at the top of `fe/app/globals.css` (colours, radius, font).
