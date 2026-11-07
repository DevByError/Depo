import { FASTAPI_FROM_BLOCKS } from "./fastapi-service";
import { WEB_FROM_BLOCKS } from "./react-web-app";
import { renderSet } from "./render";
import { FASTAPI_TEMPLATES } from "./templates-fastapi-service";
import { FULLSTACK_TEMPLATES } from "./templates-fullstack";
import { WEB_TEMPLATES } from "./templates-react-web-app";
import type { Blueprint } from "./types";

/** Each part keeps only what belongs to it; the root has one .gitignore and .gitattributes. */
const ROOT_ONLY = new Set([".gitignore", ".gitattributes"]);
const without = (t: Record<string, string>) =>
  Object.fromEntries(Object.entries(t).filter(([k]) => !ROOT_ONLY.has(k)));

export const FULLSTACK_GUIDE = [
  "api/ is the FastAPI service and web/ the React app; in development web/ sends /api to the API on 127.0.0.1:8000.",
  "API: routes in api/app/api/routes, schemas in api/app/schemas, rules in api/app/services, SQL in api/app/repositories, migrations in api/app/db/migrations.py, tests in api/tests; permissions in POLICY (api/app/core/security.py), routes guarded by Depends(require('<names>:<action>')).",
  "Web: web/src/features/<name>/ (api.ts, screens, tests), routes in web/src/App.tsx, UI pieces in web/src/components/ui.",
  "New feature (copy projects): migration step, schema, repository, service, routes, router included in api/app/main.py, API tests; then web api.ts with the same field names, list, detail and form screens, routes, a list test.",
  "Install: python -m pip install -r api/requirements-dev.txt and npm --prefix web install. Test: python -m pytest -q api, npm --prefix web run typecheck, npm --prefix web test.",
  "Never remove sign-in, role checks, the error format or tests.",
].join("\n");

export const FULLSTACK: Blueprint = {
  id: "fullstack",
  title: "Full stack app",
  summary:
    "The FastAPI service and the React web app together, wired through /api, with one command to run both.",
  stack: ["Python", "FastAPI", "TypeScript", "React", "Vite", "Tailwind CSS", "SQLite"],
  features: [
    "Everything in the FastAPI service, in api/",
    "Everything in the React web app, in web/",
    "The web app's dev server passes /api to the API, so no CORS setup is needed",
    "One script starts both, one script runs every test",
    "A root README that explains how a feature goes end to end",
  ],
  runCommand: "run.cmd (Windows) or ./run.sh (macOS and Linux)",
  testCommand: "python -m pytest -q api && npm --prefix web test",
  ports: [8000, 5173],
  extendGuide: FULLSTACK_GUIDE,
  keywords: [
    "full stack",
    "full-stack",
    "fullstack",
    "web app",
    "app",
    "system",
    "platform",
    "portal",
    "dashboard",
  ],
  files: (vars) => [
    ...renderSet(FULLSTACK_TEMPLATES, vars),
    ...renderSet(without(FASTAPI_TEMPLATES), vars, "api", FASTAPI_FROM_BLOCKS),
    ...renderSet(without(WEB_TEMPLATES), vars, "web", WEB_FROM_BLOCKS),
  ],
};
