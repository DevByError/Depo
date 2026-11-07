import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { HttpCheckError, httpCheck, loopbackUrl } from "../src/preview/http-check";
import { choosePort, isPortFree } from "../src/preview/ports";
import { detectRecipes } from "../src/preview/recipes";
import { mimeType, resolveStaticPath, startStaticServer } from "../src/preview/static-server";
import { tempDir } from "./helpers";

/** Run recipes, the built-in static server and the loopback-only HTTP check. */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function project(files: Record<string, string>): string {
  const t = tempDir("depo preview");
  cleanups.push(t.cleanup);
  const root = path.join(t.dir, "my app");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const has = (ok: boolean) => async () => ok;
const pkg = (o: Record<string, unknown>) => JSON.stringify(o);

describe("run recipes", () => {
  test("FastAPI: finds the module and app variable, runs uvicorn on 127.0.0.1", async () => {
    const root = project({
      "app/__init__.py": "",
      "app/main.py": 'from fastapi import FastAPI\n\napp = FastAPI(title="Demo")\n',
      "tests/test_main.py": "from fastapi import FastAPI\nother = FastAPI()\n",
      "requirements.txt": "fastapi\n",
    });
    const d = await detectRecipes(root, { pythonHas: has(true), platform: "linux" });
    expect(d.suggested).toBe(0);
    const r = d.recipes[0];
    expect(r?.kind).toBe("fastapi");
    expect(r?.command).toContain("-m uvicorn app.main:app --host 127.0.0.1 --port {port}");
    expect(r?.command).toContain("--reload-dir app");
    expect(r?.command.startsWith("python")).toBe(true);
    expect(r?.missing).toBeNull();
    expect(r?.role).toBe("backend");
  });

  test("FastAPI: uses the project's virtual environment (Windows path) and src layouts", async () => {
    const root = project({
      "src/service/api.py": "import fastapi\napplication = fastapi.FastAPI()\n",
      ".venv/Scripts/python.exe": "",
    });
    const d = await detectRecipes(root, { pythonHas: has(true), platform: "win32" });
    const r = d.recipes[0];
    expect(r?.command).toStartWith(".venv\\Scripts\\python.exe -m uvicorn service.api:application");
    expect(r?.command).toContain("--app-dir src");
  });

  test("FastAPI without the packages: offers to create a venv and install, never installs", async () => {
    const root = project({
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      "requirements.txt": "fastapi\n",
    });
    const d = await detectRecipes(root, { pythonHas: has(false), platform: "linux" });
    const r = d.recipes[0];
    expect(r?.missing?.install).toContain("-m venv .venv");
    expect(r?.missing?.install).toContain("pip install -r requirements.txt uvicorn");
    expect(r?.command).toStartWith(".venv/bin/python -m uvicorn main:app");
    expect(fs.existsSync(path.join(root, ".venv"))).toBe(false);
  });

  test("FastAPI app factory", async () => {
    const root = project({
      "server.py": "from fastapi import FastAPI\n\ndef create_app():\n    return FastAPI()\n",
    });
    const r = (await detectRecipes(root, { pythonHas: has(true), platform: "linux" })).recipes[0];
    expect(r?.command).toContain("server:create_app --factory");
  });

  test("Flask", async () => {
    const root = project({ "app.py": "from flask import Flask\napp = Flask(__name__)\n" });
    const r = (await detectRecipes(root, { pythonHas: has(true), platform: "linux" })).recipes[0];
    expect(r?.kind).toBe("flask");
    expect(r?.command).toContain("-m flask --app app:app run --host 127.0.0.1 --port {port}");
  });

  test("Django manage.py", async () => {
    const root = project({ "manage.py": "import django\n", "mysite/settings.py": "" });
    const r = (await detectRecipes(root, { pythonHas: has(true), platform: "linux" })).recipes[0];
    expect(r?.kind).toBe("django");
    expect(r?.command).toEndWith("manage.py runserver 127.0.0.1:{port}");
  });

  test("Next.js: passes port and host to the dev script; missing node_modules is reported", async () => {
    const root = project({
      "package.json": pkg({
        scripts: { dev: "next dev", build: "next build" },
        dependencies: { next: "15" },
      }),
    });
    const r = (await detectRecipes(root)).recipes[0];
    expect(r?.kind).toBe("next");
    expect(r?.command).toBe("npm run dev -- -p {port} -H 127.0.0.1");
    expect(r?.missing?.install).toBe("npm install");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    const again = (await detectRecipes(root)).recipes[0];
    expect(again?.command).toBe("pnpm run dev -p {port} -H 127.0.0.1");
    expect(again?.missing).toBeNull();
  });

  test("Vite", async () => {
    const root = project({
      "package.json": pkg({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "8" } }),
      "index.html": "<!doctype html>",
      "node_modules/.keep": "",
    });
    const d = await detectRecipes(root);
    expect(d.recipes[0]?.kind).toBe("vite");
    expect(d.recipes[0]?.command).toBe("npm run dev -- --port {port} --host 127.0.0.1 --strictPort");
    // index.html belongs to Vite here, not to a static site
    expect(d.recipes.some((r) => r.kind === "static")).toBe(false);
  });

  test("plain Node: runs the main file with PORT set", async () => {
    const root = project({ "package.json": pkg({ name: "x" }), "server.js": "require('http')" });
    const r = (await detectRecipes(root)).recipes[0];
    expect(r?.kind).toBe("node");
    expect(r?.command).toBe("node server.js");
    expect(r?.env.PORT).toBe("{port}");
    expect(r?.env.HOST).toBe("127.0.0.1");
  });

  test("Express through its start script, Bun through bun run dev", async () => {
    const express = project({
      "package.json": pkg({ scripts: { start: "node index.js" }, dependencies: { express: "5" } }),
      "node_modules/.keep": "",
    });
    const r = (await detectRecipes(express)).recipes[0];
    expect(r?.label).toContain("Express server");
    expect(r?.command).toBe("npm run start");
    const bun = project({
      "package.json": pkg({ scripts: { dev: "bun --watch index.ts" } }),
      "bun.lock": "",
    });
    const b = (await detectRecipes(bun)).recipes[0];
    expect(b?.kind).toBe("bun");
    expect(b?.command).toBe("bun run dev");
  });

  test("static sites: index.html at the root or in public/", async () => {
    const a = (await detectRecipes(project({ "index.html": "<h1>Hi</h1>" }))).recipes[0];
    expect(a?.kind).toBe("static");
    expect(a?.cwd).toBe("");
    expect(a?.command).toBe("");
    const b = (await detectRecipes(project({ "public/index.html": "<h1>Hi</h1>", "README.md": "" })))
      .recipes[0];
    expect(b?.cwd).toBe("public");
  });

  test("monorepo: frontend and backend together, with the API address passed to the frontend", async () => {
    const root = project({
      "frontend/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "8" } }),
      "frontend/src/api.ts": "export const base = import.meta.env.VITE_API_BASE_URL;\n",
      "backend/app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      "backend/requirements.txt": "fastapi\n",
    });
    const d = await detectRecipes(root, { pythonHas: has(true), platform: "linux" });
    const both = d.recipes[0];
    expect(both?.kind).toBe("both");
    expect(both?.parts?.map((p) => p.cwd)).toEqual(["backend", "frontend"]);
    expect(both?.parts?.[1]?.env.VITE_API_BASE_URL).toBe("{backend_url}");
    // Each part can also be started on its own.
    expect(d.recipes.map((r) => r.id)).toEqual(expect.arrayContaining(["vite:frontend", "fastapi:backend"]));
    expect(d.recipes.find((r) => r.id === "fastapi:backend")?.command).toContain("app.main:app");
  });

  test("the project's own start command wins", async () => {
    const root = project({ "index.html": "<h1>Hi</h1>" });
    const d = await detectRecipes(root, { override: "make serve PORT={port}" });
    expect(d.recipes[0]?.kind).toBe("custom");
    expect(d.recipes[0]?.command).toBe("make serve PORT={port}");
    expect(d.suggested).toBe(0);
    expect(d.recipes[1]?.kind).toBe("static");
  });

  test("nothing to start: a plain note and no suggestion", async () => {
    const d = await detectRecipes(project({ "notes.txt": "hello" }));
    expect(d.suggested).toBe(-1);
    expect(d.notes[0]).toContain("could not tell");
  });
});

describe("static server", () => {
  test("MIME types", () => {
    expect(mimeType("a/index.html")).toContain("text/html");
    expect(mimeType("x.CSS")).toContain("text/css");
    expect(mimeType("x.mjs")).toContain("text/javascript");
    expect(mimeType("x.svg")).toBe("image/svg+xml");
    expect(mimeType("x.woff2")).toBe("font/woff2");
    expect(mimeType("x.bin")).toBe("application/octet-stream");
  });

  test("path traversal, hidden files and stream names are refused", () => {
    const root = project({ "site/index.html": "ok", "secret.txt": "no" });
    const site = path.join(root, "site");
    expect(resolveStaticPath(site, "/index.html")).toBe(fs.realpathSync(path.join(site, "index.html")));
    for (const bad of [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/%2e%2e/secret.txt",
      "/.env",
      "/.git/config",
      "/index.html::$DATA",
      "/C:/Windows/win.ini",
      "/a%00.html",
      "/%E0%A4%A",
    ])
      expect(resolveStaticPath(site, bad)).toBeNull();
  });

  test("serves files with the right type, never caches, blocks escapes over HTTP", async () => {
    const root = project({
      "site/index.html": "<h1>Home</h1>",
      "site/app.js": "console.log(1)",
      "site/style.css": "body{}",
      "site/.env": "SECRET=1",
      "secret.txt": "top secret",
    });
    const site = path.join(root, "site");
    if (process.platform !== "win32")
      fs.symlinkSync(path.join(root, "secret.txt"), path.join(site, "leak.txt"));
    const lines: string[] = [];
    const port = await choosePort(0);
    const srv = startStaticServer(site, port, (l) => lines.push(l));
    cleanups.push(() => srv.stop());
    const get = (p: string) => fetch(`http://127.0.0.1:${srv.port}${p}`);

    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.get("cache-control")).toBe("no-store");
    expect(await home.text()).toBe("<h1>Home</h1>");
    expect((await get("/app.js")).headers.get("content-type")).toContain("text/javascript");
    expect((await get("/style.css")).headers.get("content-type")).toContain("text/css");
    // single-page app routes fall back to the main page; missing files are 404
    expect(await (await get("/dashboard/settings")).text()).toBe("<h1>Home</h1>");
    expect((await get("/missing.png")).status).toBe(404);
    for (const bad of ["/..%2fsecret.txt", "/..%5csecret.txt", "/.env", "/%2e%2e%2fsecret.txt"]) {
      const r = await get(bad);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await r.text()).not.toContain("top secret");
    }
    if (process.platform !== "win32") expect((await get("/leak.txt")).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${srv.port}/`, { method: "POST" })).status).toBe(405);
    expect(lines).toContain("GET / 200");
  });
});

describe("ports", () => {
  test("a taken port is not free, and choosePort finds another", async () => {
    const port = await choosePort(0);
    const srv = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("x") });
    cleanups.push(() => srv.stop(true));
    expect(await isPortFree(port)).toBe(false);
    const other = await choosePort(port);
    expect(other).not.toBe(port);
    expect(await isPortFree(other)).toBe(true);
  });
});

describe("http_check", () => {
  test("only loopback addresses are allowed", () => {
    for (const ok of [
      "http://127.0.0.1:8000/",
      "http://localhost:3000/api",
      "http://[::1]:5173/",
      "https://127.0.0.1/",
      "http://127.1:80/",
      "http://2130706433/",
    ])
      expect(loopbackUrl(ok)).not.toBeNull();
    for (const bad of [
      "http://example.com/",
      "https://10.0.0.5/",
      "http://192.168.1.10:8000/",
      "http://0.0.0.0:8000/",
      "http://127.0.0.1@evil.example/",
      "http://user:pw@127.0.0.1/",
      "http://localhost.evil.example/",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "ftp://127.0.0.1/",
      "not a url",
    ])
      expect(loopbackUrl(bad)).toBeNull();
  });

  test("refuses non-loopback hosts before any network access", async () => {
    await expect(httpCheck({ url: "http://example.com/" })).rejects.toBeInstanceOf(HttpCheckError);
    await expect(httpCheck({ url: "http://192.168.0.1/" })).rejects.toThrow("not a local address");
  });

  test("sends JSON, reports status, headers and body, and never follows redirects", async () => {
    const port = await choosePort(0);
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/go") return Response.redirect("http://example.com/", 302);
        if (req.method === "POST")
          return Response.json(
            { got: await req.json(), type: req.headers.get("content-type") },
            { status: 201 },
          );
        return new Response("x".repeat(10_000), { headers: { "content-type": "text/plain" } });
      },
    });
    cleanups.push(() => srv.stop(true));
    const posted = await httpCheck({
      url: `http://127.0.0.1:${port}/items`,
      method: "POST",
      json: { name: "a" },
    });
    expect(posted.status).toBe(201);
    expect(JSON.parse(posted.body)).toEqual({ got: { name: "a" }, type: "application/json" });
    const big = await httpCheck({ url: `http://localhost:${port}/` }, 100);
    expect(big.body.length).toBe(100);
    expect(big.bodyTruncated).toBe(true);
    const redirect = await httpCheck({ url: `http://127.0.0.1:${port}/go` });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("http://example.com/");
  });
});
