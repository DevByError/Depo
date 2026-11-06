import type { Block } from "./types";

// File contents avoid backticks and dollar-brace sequences so they can sit in String.raw safely.

export const AUTH_TS: Block = {
  id: "auth-ts",
  name: "Login and sessions (TypeScript)",
  description:
    "Password hashing with scrypt, signed expiring tokens, and register/login with a lockout after repeated failures. You supply the user store (a database table); an in-memory one is included for tests.",
  stack: "ts",
  tags: ["auth", "login", "security", "sessions"],
  test: "bun test src/auth",
  notes: [
    "Create a users table (id, email unique, password_hash, role) and implement UserStore against it.",
    "Read the secret from an environment variable (at least 32 characters); never commit it.",
    "Send the token in an HttpOnly, Secure, SameSite cookie, or in the Authorization header.",
    "Add the rbac-ts block to decide what each role may do.",
  ],
  files: [
    {
      path: "src/auth/password.ts",
      content: String.raw`import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 8;

/** Hash a password with a random salt. The result carries its own parameters. */
export function hashPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error("The password must be at least " + MIN_PASSWORD_LENGTH + " characters long.");
  }
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Check a password against a stored hash in constant time. Unknown formats never match. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
`,
    },
    {
      path: "src/auth/token.ts",
      content: String.raw`import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenPayload {
  sub: string;
  role?: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function checkSecret(secret: string) {
  if (secret.length < 32) throw new Error("The token secret must be at least 32 characters long.");
}

/** Create a signed token that stops working after ttlSeconds. */
export function signToken(
  claims: { sub: string; role?: string; [key: string]: unknown },
  secret: string,
  ttlSeconds = 3600,
  now: number = Date.now(),
): string {
  checkSecret(secret);
  const iat = Math.floor(now / 1000);
  const payload: TokenPayload = { ...claims, iat, exp: iat + ttlSeconds };
  const body = b64(JSON.stringify(payload));
  return body + "." + sign(body, secret);
}

/** Returns the payload when the signature is valid and the token has not expired, otherwise null. */
export function verifyToken(token: string, secret: string, now: number = Date.now()): TokenPayload | null {
  checkSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= Math.floor(now / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
`,
    },
    {
      path: "src/auth/index.ts",
      content: String.raw`import { hashPassword, verifyPassword } from "./password";
import { signToken, type TokenPayload, verifyToken } from "./token";

export { hashPassword, verifyPassword } from "./password";
export { signToken, type TokenPayload, verifyToken } from "./token";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
}

/** Implement this on top of your database. */
export interface UserStore {
  findByEmail(email: string): Promise<User | null>;
  create(user: { email: string; passwordHash: string; role: string }): Promise<User>;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_credentials" | "locked" | "email_taken" | "invalid_input",
  ) {
    super(message);
  }
}

export interface AuthOptions {
  store: UserStore;
  secret: string;
  ttlSeconds?: number;
  maxAttempts?: number;
  lockSeconds?: number;
  now?: () => number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Checked when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = hashPassword("not-a-real-password");

export function createAuth(opts: AuthOptions) {
  const ttl = opts.ttlSeconds ?? 3600;
  const maxAttempts = opts.maxAttempts ?? 5;
  const lockMs = (opts.lockSeconds ?? 300) * 1000;
  const now = opts.now ?? (() => Date.now());
  const failures = new Map<string, { count: number; until: number }>();

  return {
    async register(email: string, password: string, role = "user"): Promise<User> {
      const e = email.trim().toLowerCase();
      if (!EMAIL.test(e)) throw new AuthError("Enter a valid email address.", "invalid_input");
      if (await opts.store.findByEmail(e)) throw new AuthError("This email is already registered.", "email_taken");
      let passwordHash: string;
      try {
        passwordHash = hashPassword(password);
      } catch (err) {
        throw new AuthError((err as Error).message, "invalid_input");
      }
      return opts.store.create({ email: e, passwordHash, role });
    },

    async login(email: string, password: string): Promise<{ token: string; user: User }> {
      const e = email.trim().toLowerCase();
      const state = failures.get(e);
      if (state && state.until > now()) throw new AuthError("Too many attempts. Try again later.", "locked");
      const user = await opts.store.findByEmail(e);
      const ok = verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
      if (!user || !ok) {
        const count = (state && state.until > now() - lockMs ? state.count : 0) + 1;
        failures.set(e, { count, until: count >= maxAttempts ? now() + lockMs : 0 });
        throw new AuthError("The email or password is wrong.", "invalid_credentials");
      }
      failures.delete(e);
      return { token: signToken({ sub: user.id, role: user.role }, opts.secret, ttl, now()), user };
    },

    /** The payload for a valid token, or null. */
    authenticate(token: string | null | undefined): TokenPayload | null {
      return token ? verifyToken(token, opts.secret, now()) : null;
    },
  };
}

/** A store that lives in memory. For tests and demos only. */
export function memoryStore(): UserStore {
  const users = new Map<string, User>();
  return {
    async findByEmail(email) {
      return users.get(email) ?? null;
    },
    async create(u) {
      const user: User = { id: "u" + (users.size + 1), ...u };
      users.set(u.email, user);
      return user;
    },
  };
}
`,
    },
    {
      path: "src/auth/auth.test.ts",
      content: String.raw`import { describe, expect, test } from "bun:test";
import { AuthError, createAuth, hashPassword, memoryStore, signToken, verifyPassword, verifyToken } from "./index";

const SECRET = "x".repeat(40);

describe("passwords", () => {
  test("hash, verify, and reject a wrong password or a broken hash", () => {
    const h = hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("correct horse");
    expect(verifyPassword("correct horse battery", h)).toBe(true);
    expect(verifyPassword("wrong password", h)).toBe(false);
    expect(verifyPassword("anything", "garbage")).toBe(false);
    expect(hashPassword("correct horse battery")).not.toBe(h);
    expect(() => hashPassword("short")).toThrow("at least");
  });
});

describe("tokens", () => {
  test("a token verifies, expires, and cannot be tampered with", () => {
    const t = signToken({ sub: "u1", role: "admin" }, SECRET, 60, 1_000_000);
    expect(verifyToken(t, SECRET, 1_000_000)?.sub).toBe("u1");
    expect(verifyToken(t, SECRET, 1_000_000 + 61_000)).toBeNull();
    expect(verifyToken(t, "y".repeat(40), 1_000_000)).toBeNull();
    const [body, sig] = t.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ sub: "u1", role: "root", iat: 1000, exp: 99999999999 })).toString("base64url");
    expect(verifyToken(forged + "." + sig, SECRET, 1_000_000)).toBeNull();
    expect(verifyToken(body, SECRET)).toBeNull();
    expect(() => signToken({ sub: "u" }, "short")).toThrow("32");
  });
});

describe("register and login", () => {
  test("register, login, authenticate, and refuse duplicates and bad input", async () => {
    const auth = createAuth({ store: memoryStore(), secret: SECRET });
    const u = await auth.register(" Ann@Example.com ", "a-long-password");
    expect(u.email).toBe("ann@example.com");
    await expect(auth.register("ann@example.com", "a-long-password")).rejects.toMatchObject({ code: "email_taken" });
    await expect(auth.register("not-an-email", "a-long-password")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(auth.register("b@example.com", "short")).rejects.toMatchObject({ code: "invalid_input" });
    const { token } = await auth.login("ANN@example.com", "a-long-password");
    expect(auth.authenticate(token)?.sub).toBe(u.id);
    expect(auth.authenticate("nope")).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
  });

  test("wrong credentials give the same error, and repeated failures lock the account for a while", async () => {
    let t = 0;
    const auth = createAuth({ store: memoryStore(), secret: SECRET, maxAttempts: 3, lockSeconds: 60, now: () => t });
    await auth.register("c@example.com", "a-long-password");
    const err1 = await auth.login("c@example.com", "bad-password").catch((e: AuthError) => e);
    const err2 = await auth.login("nobody@example.com", "bad-password").catch((e: AuthError) => e);
    expect((err1 as AuthError).message).toBe((err2 as AuthError).message);
    await auth.login("c@example.com", "bad-password").catch(() => {});
    await auth.login("c@example.com", "bad-password").catch(() => {});
    await expect(auth.login("c@example.com", "a-long-password")).rejects.toMatchObject({ code: "locked" });
    t += 61_000;
    expect((await auth.login("c@example.com", "a-long-password")).user.email).toBe("c@example.com");
  });
});
`,
    },
  ],
};

export const RBAC_TS: Block = {
  id: "rbac-ts",
  name: "Roles and permissions (TypeScript)",
  description:
    "A small role-based access policy: roles list permissions such as 'posts:write', roles can inherit from other roles, and wildcards like 'posts:*' are supported. Deny by default.",
  stack: "ts",
  tags: ["roles", "permissions", "authorization", "security"],
  test: "bun test src/rbac",
  notes: [
    "Define one policy for the whole system and check it on the server for every route, not only in the UI.",
    "Check the permission, not the role name: can(user.role, 'invoices:delete').",
    "Combine with auth-ts: read the role from the verified token.",
  ],
  files: [
    {
      path: "src/rbac/index.ts",
      content: String.raw`export type Permission = string;

export interface PolicyDefinition<R extends string> {
  /** Permissions each role has, e.g. { admin: ["*"], editor: ["posts:read", "posts:write"] }. */
  roles: Record<R, readonly Permission[]>;
  /** Roles whose permissions a role also gets, e.g. { admin: ["editor"] }. */
  inherits?: Partial<Record<R, readonly R[]>>;
}

export class ForbiddenError extends Error {
  constructor(public readonly permission: string) {
    super("You are not allowed to do this (" + permission + ").");
  }
}

function matches(granted: string, wanted: string): boolean {
  if (granted === "*" || granted === wanted) return true;
  if (granted.endsWith(":*")) return wanted.startsWith(granted.slice(0, -1));
  return false;
}

export function definePolicy<R extends string>(def: PolicyDefinition<R>) {
  const resolved = new Map<string, Set<string>>();

  function permissionsOf(role: string, seen: string[] = []): Set<string> {
    const cached = resolved.get(role);
    if (cached) return cached;
    if (seen.includes(role)) throw new Error("Roles inherit from each other in a loop: " + [...seen, role].join(" -> "));
    const out = new Set<string>((def.roles as Record<string, readonly string[]>)[role] ?? []);
    for (const parent of (def.inherits as Record<string, readonly string[]> | undefined)?.[role] ?? []) {
      for (const p of permissionsOf(parent, [...seen, role])) out.add(p);
    }
    resolved.set(role, out);
    return out;
  }

  // Fail at start-up, not on the first request.
  for (const role of Object.keys(def.roles)) permissionsOf(role);

  return {
    /** True only when the role is known and one of its permissions covers the request. */
    can(role: string | null | undefined, permission: Permission): boolean {
      if (!role || !(role in def.roles)) return false;
      for (const granted of permissionsOf(role)) if (matches(granted, permission)) return true;
      return false;
    },
    assertCan(role: string | null | undefined, permission: Permission): void {
      if (!this.can(role, permission)) throw new ForbiddenError(permission);
    },
    permissionsOf(role: string): string[] {
      return [...permissionsOf(role)].sort();
    },
  };
}
`,
    },
    {
      path: "src/rbac/rbac.test.ts",
      content: String.raw`import { describe, expect, test } from "bun:test";
import { definePolicy, ForbiddenError } from "./index";

const policy = definePolicy({
  roles: {
    viewer: ["posts:read"],
    editor: ["posts:write", "comments:*"],
    admin: ["users:*"],
    root: ["*"],
  },
  inherits: { editor: ["viewer"], admin: ["editor"] },
});

describe("roles and permissions", () => {
  test("a role has its own permissions and the ones it inherits", () => {
    expect(policy.can("viewer", "posts:read")).toBe(true);
    expect(policy.can("viewer", "posts:write")).toBe(false);
    expect(policy.can("editor", "posts:read")).toBe(true);
    expect(policy.can("admin", "posts:write")).toBe(true);
    expect(policy.can("admin", "users:delete")).toBe(true);
  });

  test("wildcards cover a family of permissions and nothing else", () => {
    expect(policy.can("editor", "comments:delete")).toBe(true);
    expect(policy.can("editor", "commentsX:delete")).toBe(false);
    expect(policy.can("root", "anything:at-all")).toBe(true);
  });

  test("it denies by default: unknown roles, no role, unknown permissions", () => {
    expect(policy.can("hacker", "posts:read")).toBe(false);
    expect(policy.can(null, "posts:read")).toBe(false);
    expect(policy.can(undefined, "posts:read")).toBe(false);
    expect(policy.can("viewer", "billing:read")).toBe(false);
  });

  test("assertCan throws a ForbiddenError, and a loop in inheritance is rejected at start-up", () => {
    expect(() => policy.assertCan("viewer", "posts:write")).toThrow(ForbiddenError);
    expect(() => policy.assertCan("editor", "posts:write")).not.toThrow();
    expect(() => definePolicy({ roles: { a: [], b: [] }, inherits: { a: ["b"], b: ["a"] } })).toThrow("loop");
    expect(policy.permissionsOf("editor")).toEqual(["comments:*", "posts:read", "posts:write"]);
  });
});
`,
    },
  ],
};

export const AUDIT_TS: Block = {
  id: "audit-log-ts",
  name: "Tamper-evident audit log (TypeScript)",
  description:
    "An append-only log of who did what. Every line includes the hash of the previous one, so editing or deleting an earlier line is detected by verifyAudit.",
  stack: "ts",
  tags: ["audit", "logging", "security", "compliance"],
  test: "bun test src/audit",
  notes: [
    "Write an entry for sign-ins, permission changes, deletions and other sensitive actions.",
    "Never put passwords, tokens or full card numbers in an entry.",
    "Run verifyAudit on a schedule and alert when it reports a problem.",
  ],
  files: [
    {
      path: "src/audit/index.ts",
      content: String.raw`import { createHash } from "node:crypto";
import fs from "node:fs";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  detail?: Record<string, string | number | boolean>;
}

interface Line extends AuditEntry {
  at: string;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function hashOf(l: Omit<Line, "hash">): string {
  return createHash("sha256")
    .update(JSON.stringify([l.at, l.actor, l.action, l.target ?? null, l.detail ?? null, l.prev]))
    .digest("hex");
}

function lastHash(file: string): string {
  if (!fs.existsSync(file)) return GENESIS;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const last = lines.at(-1);
  return last ? (JSON.parse(last) as Line).hash : GENESIS;
}

/** Add one entry at the end of the file. */
export function appendAudit(file: string, entry: AuditEntry, now: Date = new Date()): void {
  const base = { ...entry, at: now.toISOString(), prev: lastHash(file) };
  const line: Line = { ...base, hash: hashOf(base) };
  fs.appendFileSync(file, JSON.stringify(line) + "\n");
}

/** Check the whole chain. ok is false when a line was changed, removed, or inserted. */
export function verifyAudit(file: string): { ok: boolean; entries: number; brokenAtLine?: number } {
  if (!fs.existsSync(file)) return { ok: true, entries: 0 };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    try {
      const l = JSON.parse(lines[i] as string) as Line;
      const { hash, ...rest } = l;
      if (l.prev !== prev || hashOf(rest) !== hash) return { ok: false, entries: lines.length, brokenAtLine: i + 1 };
      prev = hash;
    } catch {
      return { ok: false, entries: lines.length, brokenAtLine: i + 1 };
    }
  }
  return { ok: true, entries: lines.length };
}
`,
    },
    {
      path: "src/audit/audit.test.ts",
      content: String.raw`import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAudit, verifyAudit } from "./index";

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  return { file: path.join(dir, "audit.log"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a clean log verifies and an empty one is fine", () => {
  const t = tmp();
  expect(verifyAudit(t.file)).toEqual({ ok: true, entries: 0 });
  appendAudit(t.file, { actor: "u1", action: "login" });
  appendAudit(t.file, { actor: "u1", action: "delete", target: "invoice:7", detail: { forced: false } });
  expect(verifyAudit(t.file)).toEqual({ ok: true, entries: 2 });
  t.done();
});

test("editing, removing or reordering a line is detected", () => {
  const t = tmp();
  for (const a of ["login", "create", "delete"]) appendAudit(t.file, { actor: "u1", action: a });
  const lines = fs.readFileSync(t.file, "utf8").split("\n").filter(Boolean);

  fs.writeFileSync(t.file, [lines[0], (lines[1] as string).replace("create", "read"), lines[2]].join("\n") + "\n");
  expect(verifyAudit(t.file)).toMatchObject({ ok: false, brokenAtLine: 2 });

  fs.writeFileSync(t.file, [lines[0], lines[2]].join("\n") + "\n");
  expect(verifyAudit(t.file)).toMatchObject({ ok: false, brokenAtLine: 2 });

  fs.writeFileSync(t.file, [lines[1], lines[0], lines[2]].join("\n") + "\n");
  expect(verifyAudit(t.file).ok).toBe(false);

  fs.writeFileSync(t.file, "not json\n");
  expect(verifyAudit(t.file)).toMatchObject({ ok: false, brokenAtLine: 1 });
  t.done();
});
`,
    },
  ],
};

export const RATE_TS: Block = {
  id: "rate-limit-ts",
  name: "Rate limiter (TypeScript)",
  description:
    "A token-bucket rate limiter keyed by user, IP or API key. Returns how long to wait when a request is refused. The clock is injectable so it is easy to test.",
  stack: "ts",
  tags: ["rate limit", "security", "api", "abuse"],
  test: "bun test src/rate-limit",
  notes: [
    "Create one limiter per kind of route (for example 5 per minute for login, 100 per minute for the API).",
    "Answer with status 429 and a Retry-After header set to retryAfterSeconds.",
    "State lives in memory: with several server processes use a shared store such as Redis.",
  ],
  files: [
    {
      path: "src/rate-limit/index.ts",
      content: String.raw`export interface RateLimitOptions {
  /** How many requests can be made in a burst. */
  capacity: number;
  /** How many tokens come back per second. */
  refillPerSecond: number;
  now?: () => number;
  /** Forget keys that have been idle this long (milliseconds). */
  idleMs?: number;
}

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function createRateLimiter(opts: RateLimitOptions) {
  if (opts.capacity < 1 || opts.refillPerSecond <= 0) throw new Error("capacity must be 1 or more and refillPerSecond above 0.");
  const now = opts.now ?? (() => Date.now());
  const idleMs = opts.idleMs ?? 10 * 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  let lastSweep = now();

  return {
    take(key: string, cost = 1): RateResult {
      const t = now();
      if (t - lastSweep > idleMs) {
        for (const [k, b] of buckets) if (t - b.at > idleMs) buckets.delete(k);
        lastSweep = t;
      }
      const b = buckets.get(key) ?? { tokens: opts.capacity, at: t };
      b.tokens = Math.min(opts.capacity, b.tokens + ((t - b.at) / 1000) * opts.refillPerSecond);
      b.at = t;
      if (b.tokens >= cost) {
        b.tokens -= cost;
        buckets.set(key, b);
        return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSeconds: 0 };
      }
      buckets.set(key, b);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((cost - b.tokens) / opts.refillPerSecond) };
    },
    size: () => buckets.size,
  };
}
`,
    },
    {
      path: "src/rate-limit/rate-limit.test.ts",
      content: String.raw`import { expect, test } from "bun:test";
import { createRateLimiter } from "./index";

test("allows a burst, then refuses, then lets requests through as tokens return", () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => t });
  expect(rl.take("a").allowed).toBe(true);
  expect(rl.take("a").allowed).toBe(true);
  expect(rl.take("a")).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
  const refused = rl.take("a");
  expect(refused.allowed).toBe(false);
  expect(refused.retryAfterSeconds).toBe(1);
  t += 1000;
  expect(rl.take("a").allowed).toBe(true);
  expect(rl.take("a").allowed).toBe(false);
});

test("keys are independent and the bucket never holds more than its capacity", () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 2, refillPerSecond: 10, now: () => t });
  rl.take("a");
  rl.take("a");
  expect(rl.take("b").allowed).toBe(true);
  t += 60_000;
  expect(rl.take("a").remaining).toBe(1);
});

test("idle keys are forgotten and bad settings are rejected", () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => t, idleMs: 1000 });
  rl.take("a");
  rl.take("b");
  expect(rl.size()).toBe(2);
  t += 5000;
  rl.take("c");
  expect(rl.size()).toBe(1);
  expect(() => createRateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow();
});
`,
    },
  ],
};

export const ENV_TS: Block = {
  id: "env-config-ts",
  name: "Environment configuration (TypeScript)",
  description:
    "Reads settings from environment variables with types, defaults and required checks, and reports every problem at once at start-up instead of failing later.",
  stack: "ts",
  tags: ["config", "environment", "secrets", "twelve-factor"],
  test: "bun test src/config",
  notes: [
    "Describe every setting once in a spec and import the result everywhere else.",
    "Keep real values in .env (ignored by git) and list the names in .env.example.",
    "Mark secrets with secret: true so they are hidden when the settings are printed.",
  ],
  files: [
    {
      path: "src/config/index.ts",
      content: String.raw`type Kind = "string" | "number" | "boolean" | "url";

export interface Field {
  type: Kind;
  required?: boolean;
  default?: string | number | boolean;
  secret?: boolean;
  min?: number;
  max?: number;
}

type ValueOf<F extends Field> = F["type"] extends "number" ? number : F["type"] extends "boolean" ? boolean : string;
export type Config<S extends Record<string, Field>> = { [K in keyof S]: ValueOf<S[K]> };

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super("Configuration problems:\n- " + problems.join("\n- "));
  }
}

/** Read and check the settings. Throws one ConfigError listing every problem. */
export function loadConfig<S extends Record<string, Field>>(
  spec: S,
  source: Record<string, string | undefined> = process.env,
): Config<S> {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, f] of Object.entries(spec)) {
    const raw = source[name];
    if (raw === undefined || raw === "") {
      if (f.default !== undefined) out[name] = f.default;
      else if (f.required !== false) problems.push(name + " is missing.");
      continue;
    }
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) problems.push(name + " must be a number.");
      else if (f.min !== undefined && n < f.min) problems.push(name + " must be at least " + f.min + ".");
      else if (f.max !== undefined && n > f.max) problems.push(name + " must be at most " + f.max + ".");
      else out[name] = n;
    } else if (f.type === "boolean") {
      if (/^(true|1|yes|on)$/i.test(raw)) out[name] = true;
      else if (/^(false|0|no|off)$/i.test(raw)) out[name] = false;
      else problems.push(name + " must be true or false.");
    } else if (f.type === "url") {
      try {
        new URL(raw);
        out[name] = raw;
      } catch {
        problems.push(name + " must be a full URL.");
      }
    } else {
      if (f.min !== undefined && raw.length < f.min) problems.push(name + " must be at least " + f.min + " characters.");
      else out[name] = raw;
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return out as Config<S>;
}

/** The settings as text for logs, with secrets hidden. */
export function describeConfig(spec: Record<string, Field>, config: Record<string, unknown>): string {
  return Object.keys(config)
    .map((k) => k + "=" + (spec[k]?.secret ? "***" : String(config[k])))
    .join("\n");
}
`,
    },
    {
      path: "src/config/config.test.ts",
      content: String.raw`import { expect, test } from "bun:test";
import { ConfigError, describeConfig, loadConfig } from "./index";

const spec = {
  PORT: { type: "number", default: 3000, min: 1, max: 65535 },
  DATABASE_URL: { type: "url", required: true },
  JWT_SECRET: { type: "string", required: true, secret: true, min: 32 },
  DEBUG: { type: "boolean", default: false },
} as const;

test("reads typed values and applies defaults", () => {
  const c = loadConfig(spec, { DATABASE_URL: "postgres://localhost/app", JWT_SECRET: "s".repeat(32), DEBUG: "yes", PORT: "8080" });
  expect(c.PORT).toBe(8080);
  expect(c.DEBUG).toBe(true);
  expect(loadConfig(spec, { DATABASE_URL: "http://x", JWT_SECRET: "s".repeat(32) }).PORT).toBe(3000);
});

test("reports every problem at once", () => {
  try {
    loadConfig(spec, { PORT: "99999", JWT_SECRET: "short", DEBUG: "maybe" });
    throw new Error("should have failed");
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const p = (e as ConfigError).problems.join("|");
    expect(p).toContain("PORT must be at most");
    expect(p).toContain("DATABASE_URL is missing");
    expect(p).toContain("JWT_SECRET must be at least 32");
    expect(p).toContain("DEBUG must be true or false");
  }
});

test("secrets are hidden when settings are described", () => {
  const c = loadConfig(spec, { DATABASE_URL: "http://x", JWT_SECRET: "s".repeat(32) });
  const text = describeConfig(spec, c);
  expect(text).toContain("JWT_SECRET=***");
  expect(text).not.toContain("ssss");
});
`,
    },
  ],
};

export const PAGINATE_TS: Block = {
  id: "paginate-ts",
  name: "Cursor pagination (TypeScript)",
  description:
    "Opaque cursors for list endpoints: stable between requests even when rows are added, with limits and validation so a client cannot ask for everything or forge a cursor into something harmful.",
  stack: "ts",
  tags: ["pagination", "api", "lists"],
  test: "bun test src/pagination",
  notes: [
    "Sort by a unique, stable column (for example created_at then id) and pass the last row's values to nextCursor.",
    "In SQL use WHERE (created_at, id) < (:createdAt, :id) ORDER BY created_at DESC, id DESC LIMIT :limit + 1.",
    "Return nextCursor to the client and ask for it back as ?cursor=.",
  ],
  files: [
    {
      path: "src/pagination/index.ts",
      content: String.raw`export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type CursorValue = string | number;

export function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

/** Returns the values in a cursor, or null when it is not one this module made. */
export function decodeCursor(cursor: string | null | undefined): CursorValue[] | null {
  if (!cursor || cursor.length > 500) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length === 0 || v.length > 4) return null;
    return v.every((x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x))) ? v : null;
  } catch {
    return null;
  }
}

/** Turn the ?limit= text into a safe number. */
export function parseLimit(raw: string | number | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Cut one page from rows fetched with limit + 1. keyOf says which values identify a row's position.
 */
export function pageOf<T>(rowsFetched: T[], limit: number, keyOf: (row: T) => CursorValue[]) {
  const hasMore = rowsFetched.length > limit;
  const items = hasMore ? rowsFetched.slice(0, limit) : rowsFetched;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null };
}
`,
    },
    {
      path: "src/pagination/pagination.test.ts",
      content: String.raw`import { expect, test } from "bun:test";
import { decodeCursor, encodeCursor, MAX_LIMIT, pageOf, parseLimit } from "./index";

test("cursors round-trip and forged ones are refused", () => {
  const c = encodeCursor(["2024-01-01T00:00:00Z", 42]);
  expect(decodeCursor(c)).toEqual(["2024-01-01T00:00:00Z", 42]);
  expect(decodeCursor(null)).toBeNull();
  expect(decodeCursor("not-base64!!")).toBeNull();
  expect(decodeCursor(Buffer.from('{"a":1}').toString("base64url"))).toBeNull();
  expect(decodeCursor(Buffer.from("[[1]]").toString("base64url"))).toBeNull();
  expect(decodeCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
  expect(decodeCursor("x".repeat(600))).toBeNull();
});

test("the limit is always inside a safe range", () => {
  expect(parseLimit(undefined)).toBe(20);
  expect(parseLimit("abc")).toBe(20);
  expect(parseLimit("-5")).toBe(20);
  expect(parseLimit("5")).toBe(5);
  expect(parseLimit("100000")).toBe(MAX_LIMIT);
});

test("a page has a next cursor only when there are more rows", () => {
  const rows = [1, 2, 3, 4].map((id) => ({ id }));
  const p = pageOf(rows, 3, (r) => [r.id]);
  expect(p.items).toHaveLength(3);
  expect(decodeCursor(p.nextCursor)).toEqual([3]);
  expect(pageOf(rows.slice(0, 3), 3, (r) => [r.id]).nextCursor).toBeNull();
  expect(pageOf([], 3, (r: { id: number }) => [r.id])).toEqual({ items: [], nextCursor: null });
});
`,
    },
  ],
};
