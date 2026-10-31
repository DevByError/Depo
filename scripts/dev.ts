#!/usr/bin/env bun
/**
 * Browser dev loop without Tauri: starts the engine, then Vite with the engine URL.
 * Open http://127.0.0.1:1420. For the real desktop window use `bun run tauri:dev`.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ENGINE_READY_PREFIX, EngineReadySchema } from "../packages/shared/src/index";

const root = path.resolve(import.meta.dir, "..");
const token = randomBytes(32).toString("hex");

const engine = Bun.spawn(["bun", "--watch", path.join(root, "packages/engine/src/main.ts")], {
  env: {
    ...process.env,
    DEPO_ENGINE_TOKEN: token,
    DEPO_ENGINE_PORT: process.env.DEPO_ENGINE_PORT ?? "47100",
  },
  stdout: "pipe",
  stderr: "inherit",
});

const port = await readReadyPort(engine.stdout);
const url = `ws://127.0.0.1:${port}/rpc?token=${token}`;
console.log(`engine ready on port ${port}`);

const vite = Bun.spawn(["bun", "run", "dev:vite"], {
  cwd: path.join(root, "apps/desktop"),
  env: { ...process.env, VITE_DEPO_ENGINE_URL: url },
  stdout: "inherit",
  stderr: "inherit",
});

const stop = () => {
  vite.kill();
  engine.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([vite.exited, engine.exited]);
stop();

async function readReadyPort(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("engine exited before it was ready");
    buf += decoder.decode(value, { stream: true });
    const line = buf.split(/\r?\n/).find((l) => l.startsWith(ENGINE_READY_PREFIX));
    if (line) {
      reader.releaseLock();
      // Keep draining stdout so the engine never blocks on a full pipe (bun --watch restarts print again).
      void stream.pipeTo(new WritableStream());
      return EngineReadySchema.parse(JSON.parse(line.slice(ENGINE_READY_PREFIX.length))).port;
    }
  }
}
