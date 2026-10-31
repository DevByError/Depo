import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test("writes JSON lines with redaction and rotates by size", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, maxBytes: 300, maxFiles: 2 });
  log.info("hello", { token: "secret-value", n: 1 });
  const first = JSON.parse(readFileSync(log.file, "utf8").trim().split("\n")[0] ?? "{}");
  expect(first).toMatchObject({ level: "info", msg: "hello", n: 1, token: "«redacted»" });

  for (let i = 0; i < 40; i++) log.info("filler line to force rotation", { i });
  expect(existsSync(path.join(t.dir, "engine.1.log"))).toBe(true);
  expect(existsSync(path.join(t.dir, "engine.2.log"))).toBe(true);
  expect(existsSync(path.join(t.dir, "engine.3.log"))).toBe(false);
});

test("respects log level", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, level: "warn" });
  log.info("skip");
  log.warn("keep");
  expect(readFileSync(log.file, "utf8").trim().split("\n")).toHaveLength(1);
});
