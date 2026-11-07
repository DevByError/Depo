import { renderSet } from "./render";
import { NEXT_BUN_TEMPLATES } from "./templates-next-bun-mysql";
import type { Blueprint } from "./types";

export const NEXT_BUN_GUIDE = [
  "fe/ is the Next.js app (App Router), be/ the Bun + TypeScript API with MySQL; the browser calls /api/... on fe and Next passes it to be (BACKEND_URL).",
  "API: routes in be/src/app.ts (one table), each feature in its own folder like be/src/auth (handlers + validation), data through the Store interface in be/src/db/store.ts with mysql.ts and memory.ts versions, new tables at the end of be/src/db/schema.sql, tests in be/src/app.test.ts (memory store).",
  "Web: pages in fe/app/<route>/page.tsx, shared pieces in fe/components (AuthCard, Field), API calls in fe/lib/api.ts, checks in fe/lib/validate.ts; colours, radius and font only through the tokens at the top of fe/app/globals.css (var(--primary) etc.).",
  "New feature: table in schema.sql, Store methods (both versions), handler + route + test in be, then lib/api.ts, a page and its form in fe.",
  "Install: cd be && bun install; cd fe && bun install. Test: cd be && bun test && bun run typecheck; cd fe && bun test lib && bun run typecheck. Database: be/.env DATABASE_URL, then bun run db:migrate and bun run db:seed.",
  "Never remove sign-in, the session cookie flags, password hashing, the error format or tests.",
].join("\n");

export const NEXT_BUN_MYSQL: Blueprint = {
  id: "next-bun-mysql",
  title: "Next.js + Bun + MySQL app",
  summary:
    "A Next.js web app (fe/) and a Bun + TypeScript API (be/) with MySQL, with sign up, sign in and sign out working and tested.",
  stack: ["TypeScript", "Next.js", "React", "Bun", "MySQL"],
  features: [
    "Sign up, sign in and sign out with sessions in an HttpOnly cookie and Argon2id passwords",
    "MySQL or MariaDB tables, a migration command that also creates the database, and demo accounts",
    "Works without a database too: users are kept in memory for a quick try",
    "Next passes /api to the API, so there is no CORS setup and the cookie stays on one site",
    "Clear field errors from both the web app and the API, and a limit on wrong passwords",
    "One set of theme tokens for colours, corners and font",
    "Tests for the whole sign-in flow and the form checks",
  ],
  runCommand: "run.cmd (Windows) or ./run.sh (macOS and Linux)",
  testCommand: "cd be && bun test && cd ../fe && bun test lib",
  ports: [4000, 3000],
  extendGuide: NEXT_BUN_GUIDE,
  keywords: ["next", "nextjs", "next.js", "bun", "mysql", "mariadb", "fe", "be", "login", "register"],
  files: (vars) => renderSet(NEXT_BUN_TEMPLATES, vars),
};
