import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent } from "@depo/shared";
import { startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { chunk } from "../src/codeindex/indexer";
import { languageFor } from "../src/codeindex/languages";
import { extractSymbols } from "../src/codeindex/symbols";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
let stopFake = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  stopFake();
  stopFake = () => {};
  cleanup();
  cleanup = () => {};
});

describe("symbols", () => {
  test("python classes, methods and functions", async () => {
    const src = [
      "import os",
      "",
      "class Cart:",
      "    def add(self, item):",
      "        return item",
      "",
      "def checkout(cart: Cart) -> int:",
      "    return 1",
      "",
    ].join("\n");
    const syms = await extractSymbols("python", src);
    expect(syms.map((s) => [s.kind, s.name, s.parent])).toEqual([
      ["class", "Cart", null],
      ["method", "add", "Cart"],
      ["function", "checkout", null],
    ]);
    expect(syms.find((s) => s.name === "checkout")?.signature).toContain("def checkout(cart: Cart) -> int");
    expect(syms.find((s) => s.name === "Cart")?.startLine).toBe(3);
  });

  test("typescript functions, arrow functions, classes, interfaces", async () => {
    const src = [
      "export interface User { id: string }",
      "export type Id = string;",
      "export function load(id: Id): User { return { id }; }",
      "export const save = async (u: User) => u;",
      "export class Repo {",
      "  find(id: string) { return id; }",
      "}",
    ].join("\n");
    const names = (await extractSymbols("typescript", src)).map((s) => `${s.kind}:${s.name}`);
    for (const n of [
      "interface:User",
      "type:Id",
      "function:load",
      "function:save",
      "class:Repo",
      "method:find",
    ])
      expect(names).toContain(n);
  });

  test("go and rust", async () => {
    const go =
      "package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() error { return nil }\n\nfunc main() {}\n";
    const goNames = (await extractSymbols("go", go)).map((s) => s.name);
    expect(goNames).toEqual(expect.arrayContaining(["Server", "Start", "main"]));
    const rs =
      "pub struct Point { x: i32 }\nimpl Point { pub fn new() -> Self { Point { x: 0 } } }\nfn main() {}\n";
    const rsNames = (await extractSymbols("rust", rs)).map((s) => s.name);
    expect(rsNames).toEqual(expect.arrayContaining(["Point", "new", "main"]));
  });

  test("language detection and chunking", () => {
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("a/b.py")).toBe("python");
    expect(languageFor("README.md")).toBeNull();
    const text = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
    const parts = chunk("x.txt", text);
    expect(parts[0]).toMatchObject({ start: 1, end: 60 });
    expect(parts[1]?.start).toBe(51);
    expect(parts.at(-1)?.end).toBe(130);
  });
});

async function setup(withEmbeddings: boolean) {
  const t = tempDir("depo index");
  cleanup = t.cleanup;
  const fake = startFakeOllama();
  stopFake = fake.stop;
  const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  engine = e;
  e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
  if (withEmbeddings)
    e.models.assign("embedding", { providerId: "ollama", model: "nomic-embed-text:latest" });
  const root = path.join(t.dir, "shop");
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "app", "billing.py"),
    "def charge_credit_card(amount):\n    '''Send a payment to the card processor.'''\n    return amount\n",
  );
  fs.writeFileSync(
    path.join(root, "app", "users.py"),
    "class UserStore:\n    def find_user(self, email):\n        return email\n",
  );
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "function hidden() {}\n");
  const project = await e.projects.open(root);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, root, project, events };
}

describe("code index", () => {
  test("indexes symbols, skips dependencies, and builds a repo map", async () => {
    const { e, project, events } = await setup(false);
    e.indexer.ensure(project.id);
    await e.indexer.idle(project.id);
    const st = e.indexer.status(project.id);
    expect(st.state).toBe("idle");
    expect(st.files).toBe(2);
    expect(st.symbols).toBe(3);
    expect(st.embeddingModel).toBeNull();
    expect(st.watching).toBe(true);
    const map = e.indexer.repoMap(project.id);
    expect(map).toContain("app/billing.py");
    expect(map).toContain("charge_credit_card");
    expect(map).not.toContain("hidden");
    expect(e.indexer.findSymbols(project.id, "find_user")[0]).toMatchObject({
      path: "app/users.py",
      startLine: 2,
    });
    expect(events.some((ev) => ev.type === "indexing")).toBe(true);
  });

  test("the watcher picks up new, changed and deleted files", async () => {
    const { e, root, project } = await setup(false);
    e.indexer.ensure(project.id);
    await e.indexer.idle(project.id);
    fs.writeFileSync(path.join(root, "app", "orders.py"), "def place_order():\n    pass\n");
    await waitFor(() => (e.indexer.findSymbols(project.id, "place_order").length ? true : undefined), 8000);
    fs.rmSync(path.join(root, "app", "users.py"));
    await waitFor(
      () => (e.indexer.findSymbols(project.id, "find_user").length === 0 ? true : undefined),
      8000,
    );
    expect(e.indexer.status(project.id).files).toBe(2);
  }, 20_000);

  test("semantic search uses the embedding model through the scheduler", async () => {
    const { e, project } = await setup(true);
    e.indexer.ensure(project.id);
    await e.indexer.idle(project.id);
    const st = e.indexer.status(project.id);
    expect(st.embeddingModel).toBe("nomic-embed-text:latest");
    expect(st.chunks).toBe(2);
    const hits = await e.indexer.search(project.id, "send a payment to the processor");
    const semantic = hits.filter((h) => h.kind === "semantic");
    expect(semantic[0]?.path).toBe("app/billing.py");
  });

  test("indexing can be turned off per project", async () => {
    const { e, project } = await setup(false);
    e.registry.setSettings(project.id, { indexEnabled: false });
    e.indexer.ensure(project.id);
    expect(e.indexer.status(project.id).state).toBe("disabled");
    expect(() => e.indexer.rebuild(project.id)).toThrow("turned off");
  });
});
