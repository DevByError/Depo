import { PY_PASSWORDS, RBAC_PY } from "../blocks/other-blocks";
import { renderSet } from "./render";
import { FASTAPI_TEMPLATES } from "./templates-fastapi-service";
import type { Blueprint } from "./types";

function blockFile(block: { id: string; files: { path: string; content: string }[] }, path: string): string {
  const file = block.files.find((f) => f.path === path);
  if (!file) throw new Error(`Building block ${block.id} has no ${path}.`);
  return file.content;
}

/**
 * Taken from the building blocks as they are, so the blueprint and the blocks share one tested
 * version of the password hashing and the role policy.
 */
export const FASTAPI_FROM_BLOCKS: Record<string, string> = {
  "app/core/passwords.py": `"""Password hashing with scrypt (standard library only), from Depo's auth-py building block."""
import base64
import hashlib
import hmac
import os

${PY_PASSWORDS}`,
  "app/core/rbac.py": blockFile(RBAC_PY, "app/rbac.py"),
};

export const FASTAPI_GUIDE = [
  "Layout: app/api/routes/<name>.py HTTP only; app/schemas/<name>.py Pydantic models (<Name>In, <Name>Update, <Name>Out); app/services/<name>.py rules and owner checks; app/repositories/<name>.py SQL only with :named params; app/db/migrations.py numbered steps; tests/test_<name>.py. Files snake_case; tables and routes plural (/api/<names>).",
  "New resource (copy projects): 1 a migration step at the end (never edit old steps); 2 schemas; 3 repository; 4 service; 5 routes guarded by Depends(require('<names>:<action>')), permissions added to POLICY in app/core/security.py; 6 include the router in app/main.py; 7 tests for CRUD, 422, 404, 403 and pagination.",
  "Raise NotFound, Conflict or Forbidden from app/core/errors.py; lists return Page (page_size max 100).",
  "Install: python -m pip install -r requirements-dev.txt. Test: python -m pytest -q.",
  "Never remove sign-in, role checks, the error format or tests. Passwords stay hashed; secrets come from .env.",
].join("\n");

export const FASTAPI_SERVICE: Blueprint = {
  id: "fastapi-service",
  title: "FastAPI service",
  summary: "A REST API with accounts, roles and a complete example resource, tested with pytest.",
  stack: ["Python", "FastAPI", "SQLite", "PostgreSQL ready", "pytest"],
  features: [
    "Sign-up and sign-in with JWT, scrypt password hashing and a sign-in rate limit",
    "Admin and user roles checked on every route",
    "An example resource with CRUD, validation, pagination, filters and search",
    "One JSON error format, request logs with ids and a health check",
    "SQLite out of the box, PostgreSQL by changing one setting",
    "Migrations, a seed command for the first admin, a Dockerfile",
    "pytest tests for sign-in, roles, CRUD, validation and pagination; run scripts for Windows, macOS and Linux",
  ],
  runCommand: "python -m uvicorn app.main:app --reload --port 8000",
  testCommand: "python -m pytest -q",
  ports: [8000],
  extendGuide: FASTAPI_GUIDE,
  keywords: ["api", "backend", "back-end", "rest", "fastapi", "python", "service", "server", "endpoints"],
  files: (vars) => renderSet(FASTAPI_TEMPLATES, vars, "", FASTAPI_FROM_BLOCKS),
};
