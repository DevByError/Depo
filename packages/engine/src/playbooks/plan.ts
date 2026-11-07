import type { WorkMode } from "@depo/shared";

/**
 * The production bar for plans. When the team builds something new, the Manager is told which
 * production features the request implies (accounts when there are users, roles when "admin"
 * appears...), and every task gets testable criteria for them, also when the Manager's JSON
 * cannot be read and the standard pipeline is used.
 */

type TeamMode = Exclude<WorkMode, "single">;
const BUILD_MODES: TeamMode[] = ["full", "backend", "frontend", "ai"];

export interface SystemNeeds {
  /** People sign in: accounts, login, password reset. */
  users: boolean;
  /** Admins, staff or roles: permissions, an admin area, an audit trail. */
  admin: boolean;
  /** There is an interface to build. */
  ui: boolean;
  /** There is an API to build. */
  api: boolean;
  /** Questions answered from documents: retrieval with citations. */
  rag: boolean;
}

const USERS =
  /\b(users?|accounts?|log ?in|logins?|sign[ -]?(?:in|up)|register|registration|members?|customers?|patients?|students?|teachers?|employees?|clients?|profiles?|auth\w*|passwords?|tenants?|subscribers?|doctors?)\b/i;
const ADMIN =
  /\b(admins?|administrators?|administration|roles?|permissions?|rbac|staff|moderators?|back ?office|superusers?|access control)\b/i;
const UI =
  /\b(ui|ux|pages?|screens?|dashboards?|frontend|front-end|web ?app|website|site|portal|mobile|forms?|app)\b/i;
const API = /\b(api|apis|backend|back-end|server|endpoints?|rest|graphql)\b/i;
const RAG =
  /\b(rag|documents?|docs|knowledge base|search over|chat with|question answering|citations?|pdfs?)\b/i;

export function needsFrom(text: string, mode: TeamMode): SystemNeeds {
  const admin = ADMIN.test(text);
  return {
    users: admin || USERS.test(text),
    admin,
    ui: mode === "full" || mode === "frontend" || (mode !== "backend" && mode !== "ai" && UI.test(text)),
    api: mode === "full" || mode === "backend" || mode === "ai" || API.test(text),
    rag: RAG.test(text) && (mode === "ai" || /\b(ai|llm|chat|rag|semantic)\b/i.test(text)),
  };
}

export function isBuildMode(mode: TeamMode): boolean {
  return BUILD_MODES.includes(mode);
}

/** Extra instructions for the Manager's planning prompt. Empty for modes that do not build. */
export function planningGuide(mode: TeamMode, text: string): string {
  if (!isBuildMode(mode)) return "";
  const n = needsFrom(text, mode);
  const lines = [
    "Production bar: plan a real system, not a demo. From the request and the user stories, this work needs:",
  ];
  if (n.users)
    lines.push(
      "- Accounts: sign-up or invite, login, logout, token refresh or session expiry, password reset, Argon2id (or scrypt) hashing and a login rate limit.",
    );
  if (n.admin)
    lines.push(
      '- Roles and permissions with deny-by-default checks on every route, an admin area to manage users and roles, and an audit log of permission changes ("admin", "staff" or "roles" appear in the request).',
    );
  if (n.api)
    lines.push(
      "- Validation on every input with field errors in one error format; 404 and 409 used correctly; OpenAPI docs served by the API.",
      "- Pagination, filters and sorting on every list; database constraints and indexes for the rules; migrations and seed data.",
    );
  if (n.ui)
    lines.push(
      "- An accessible, responsive interface (360 to 1440 px, keyboard, visible focus) where every screen has loading, empty, error and success states.",
    );
  if (n.rag) lines.push("- Answers grounded in the documents with citations, and a model that runs locally.");
  lines.push(
    "- Tests for the key paths (the main user stories, failure cases" +
      (n.users ? ", sign-in" : "") +
      (n.admin ? ", permissions" : "") +
      "); a README, .env.example and one-command run scripts (run.cmd and run.sh).",
    "Put these into the criteria of the tasks that own them. Every criterion must be checkable by a tool: a command that passes, an endpoint and its status code, a file, a visible screen state.",
  );
  return lines.join("\n");
}

/** Criteria each owner gets for the production bar, given what the system needs. */
function extraCriteria(owner: string, title: string, n: SystemNeeds): string[] {
  switch (owner) {
    case "database":
      return [
        "constraints enforce the rules (NOT NULL, UNIQUE, foreign keys, CHECK) and foreign keys are indexed",
        `a seed script creates demo data${n.admin ? " including a demo admin" : ""} and can run twice`,
      ];
    case "backend":
      return [
        "every input is validated; errors use one format (422 with field errors, 404, 409)",
        "list endpoints are paginated with a capped limit",
        ...(n.users
          ? [
              "register, login, refresh and logout work with hashed passwords and a login rate limit, with tests",
            ]
          : []),
        ...(n.admin
          ? ["admin routes check permissions (403 for others) and permission changes are audited, with tests"]
          : []),
        "OpenAPI docs are served and match the routes",
      ];
    case "frontend":
      return [
        "every data screen has loading, empty, error and success states",
        "forms validate input and show server errors next to the fields",
        "usable at 360 and 1440 px and by keyboard with visible focus",
        ...(n.users ? ["sign-in and sign-up screens; signed-out visitors are sent to sign in"] : []),
        ...(n.admin ? ["an admin area to manage users and their access, hidden from other users"] : []),
      ];
    case "integration":
      return [
        ...(n.users
          ? ["the auth flow works end to end in a test: login, protected call, refresh, logout"]
          : []),
        ".env.example lists every variable",
      ];
    case "testing":
      return [
        `tests cover the main user stories and their failure cases${n.users ? ", including sign-in" : ""}`,
        ...(n.admin ? ["a role matrix test checks 401 and 403 on protected routes"] : []),
      ];
    case "devops-docs":
      return [
        "README explains setup, run and test, and every command in it works",
        "run.cmd and run.sh start everything with one command",
      ];
    case "ai-integration":
      return [
        "model URL and names come from configuration, with timeouts",
        ...(n.rag ? ["answers cite the source documents and say when the answer is not in them"] : []),
        "tests mock the model, including a runtime-down error",
      ];
    case "security":
      return n.users ? ["every route checked for authentication and ownership"] : [];
    case "ui-ux-design":
      return [
        "page specs cover loading, empty, error, success and access-denied states",
        "contrast meets WCAG 2.2 AA in light and dark themes",
      ];
    case "project-management":
      return /brief|stor/i.test(title)
        ? [
            `user stories include failure cases${n.users ? " and the account stories (sign-up, sign-in, password reset)" : ""}${n.admin ? " and the admin stories" : ""}`,
          ]
        : [];
    default:
      return [];
  }
}

const MAX_CRITERIA = 8;

function covered(existing: string[], extra: string): boolean {
  const key = extra
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((w) => w.length > 4)
    .slice(0, 2)
    .join(" ");
  return existing.some((c) => {
    const l = c.toLowerCase();
    return l.includes(extra.toLowerCase()) || (key.length > 0 && key.split(" ").every((w) => l.includes(w)));
  });
}

/**
 * Add the production bar to every task of a build plan as testable criteria (at most 8 per task).
 * Plans for fixes, refactors, questions and imports are returned unchanged.
 */
export function raiseTheBar<T extends { owner: string; title: string; criteria?: string[] }>(
  nodes: T[],
  mode: TeamMode,
  text: string,
): T[] {
  if (!isBuildMode(mode)) return nodes;
  const n = needsFrom(text, mode);
  return nodes.map((node) => {
    const criteria = [...(node.criteria ?? [])];
    for (const c of extraCriteria(node.owner, node.title, n)) {
      if (criteria.length >= MAX_CRITERIA) break;
      if (!covered(criteria, c)) criteria.push(c);
    }
    return { ...node, criteria };
  });
}
