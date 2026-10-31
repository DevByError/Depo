import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Temp dir with a space and non-ASCII characters, like many real Windows user profiles. */
export function tempDir(label = "depo test"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `${label} Ünïcødé-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const TEST_TOKEN = "t".repeat(48);

export function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
