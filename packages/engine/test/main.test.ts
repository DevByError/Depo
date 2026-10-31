import { expect, test } from "bun:test";
import path from "node:path";
import { ENGINE_READY_PREFIX, EngineReadySchema } from "@depo/shared";
import { TEST_TOKEN, tempDir } from "./helpers";

test("sidecar prints the ready handshake and exits when stdin closes", async () => {
  const t = tempDir();
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "..", "src", "main.ts")], {
    env: {
      ...process.env,
      DEPO_DATA_DIR: t.dir,
      DEPO_ENGINE_TOKEN: TEST_TOKEN,
      DEPO_EXIT_ON_STDIN_CLOSE: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  const line = buf.split("\n")[0] ?? "";
  expect(line.startsWith(ENGINE_READY_PREFIX)).toBe(true);
  const ready = EngineReadySchema.parse(JSON.parse(line.slice(ENGINE_READY_PREFIX.length)));
  expect(ready.port).toBeGreaterThan(0);

  const ping = await fetch(`http://127.0.0.1:${ready.port}/rpc?token=${TEST_TOKEN}`);
  expect(ping.status).toBe(426); // authenticated, but not a WebSocket upgrade

  proc.stdin.end();
  const code = await proc.exited;
  expect(code).toBe(0);
  t.cleanup();
}, 15000);
