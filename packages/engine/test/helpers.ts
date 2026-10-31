import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Temp dir with a space and non-ASCII characters, like many real Windows user profiles. */
export function tempDir(label = "depo test"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `${label} Ünïcødé-`));
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try {
      // Windows keeps files locked briefly after close (SQLite, Defender, indexer): retry before giving up.
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw err;
      // A leftover temp folder must not fail a test; the OS temp cleaner removes it later.
      console.warn(`could not remove temp dir (${code}): ${dir}`);
    }
  };
  return { dir, cleanup };
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
