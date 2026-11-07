import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { memoryStore } from "./db/memory";
import { statements } from "./db/migrate";
import { DEMO_USERS, seed } from "./db/seed";
import { Limiter } from "./limiter";

const config = loadConfig({});
const base = "http://localhost/api";

function setup() {
  const store = memoryStore();
  const app = createApp({ store, config, limiter: new Limiter(3, 60_000) });
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(
      new Request(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] ?? "";
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: set };
  };
  return { store, call, signOutLocally: () => (cookie = "") };
}

describe("auth", () => {
  test("register signs in, me returns the user, logout signs out", async () => {
    const { call } = setup();
    const reg = await call("POST", "/auth/register", { name: "Sam", email: "Sam@Example.com", password: "secret123" });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ name: "Sam", email: "sam@example.com" });
    expect(reg.body.user.passwordHash).toBeUndefined();
    expect(reg.setCookie).toContain("HttpOnly");
    expect(reg.setCookie).toContain("SameSite=Lax");
    expect((await call("GET", "/auth/me")).body.user.email).toBe("sam@example.com");
    const out = await call("POST", "/auth/logout");
    expect(out.status).toBe(204);
    expect(out.setCookie).toContain("Max-Age=0");
    expect((await call("GET", "/auth/me")).body).toEqual({ user: null });
  });

  test("login works with the right password only", async () => {
    const { call, signOutLocally } = setup();
    await call("POST", "/auth/register", { name: "Kim", email: "kim@example.com", password: "secret123" });
    signOutLocally();
    const wrong = await call("POST", "/auth/login", { email: "kim@example.com", password: "nope-nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("bad_credentials");
    const right = await call("POST", "/auth/login", { email: "KIM@example.com", password: "secret123" });
    expect(right.status).toBe(200);
    expect((await call("GET", "/auth/me")).body.user.name).toBe("Kim");
  });

  test("an email registers once", async () => {
    const { call } = setup();
    await call("POST", "/auth/register", { name: "A", email: "a@example.com", password: "secret123" });
    const again = await call("POST", "/auth/register", { name: "B", email: "A@example.com", password: "secret123" });
    expect(again.status).toBe(409);
    expect(again.body.error.fields.email).toBeTruthy();
  });

  test("bad input gets a message per field", async () => {
    const { call } = setup();
    const res = await call("POST", "/auth/register", { name: "", email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(["email", "name", "password"]);
    expect((await call("POST", "/auth/login", {})).status).toBe(400);
  });

  test("too many wrong passwords are slowed down", async () => {
    const { call } = setup();
    for (let i = 0; i < 3; i++)
      expect((await call("POST", "/auth/login", { email: "x@example.com", password: "wrong-one" })).status).toBe(401);
    expect((await call("POST", "/auth/login", { email: "x@example.com", password: "wrong-one" })).status).toBe(429);
  });

  test("demo users can sign in after seeding", async () => {
    const { store, call } = setup();
    expect(await seed(store)).toHaveLength(DEMO_USERS.length);
    expect(await seed(store)).toHaveLength(0);
    const demo = DEMO_USERS[0];
    if (!demo) throw new Error("no demo user");
    expect((await call("POST", "/auth/login", { email: demo.email, password: demo.password })).status).toBe(200);
  });

  test("unknown routes and broken bodies get the error format", async () => {
    const { call } = setup();
    expect((await call("GET", "/nope")).body.error.code).toBe("not_found");
    expect((await call("GET", "/health")).body).toEqual({ ok: true, store: "memory" });
  });

  test("the schema splits into statements", () => {
    expect(statements("-- c\nCREATE TABLE a (x INT);\nCREATE TABLE b (y INT);\n")).toEqual([
      "CREATE TABLE a (x INT)",
      "CREATE TABLE b (y INT)",
    ]);
  });
});
