import fs from "node:fs";
import path from "node:path";

/**
 * Deleting without freezing the engine. `fs.rmSync` with retries waits on the engine's only thread:
 * on Windows a folder of thousands of files (a copy with installed packages, a browser profile
 * that Edge still holds) takes seconds to minutes, and the heartbeat and every reply stop meanwhile.
 * Here a folder is renamed out of the way at once (so its path is free and looks gone) and deleted
 * in the background, retrying while Windows keeps a file locked.
 */

/** Name of a folder waiting for its background delete (cleared at the next start if a run ends first). */
export const TRASH_MARK = ".gone-";

const RETRY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES", "EMFILE", "ENFILE"]);
const pending = new Set<Promise<boolean>>();

/** Delete a file or folder tree without blocking, retrying while files are locked. True when it is gone. */
export async function removeTree(
  target: string,
  o: { tries?: number; delayMs?: number } = {},
): Promise<boolean> {
  const tries = Math.max(1, o.tries ?? 8);
  const delay = Math.max(1, o.delayMs ?? 200);
  for (let i = 1; i <= tries; i++) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRY_CODES.has(code) || i === tries) return false;
      await new Promise((r) => setTimeout(r, delay * i));
    }
  }
  return false;
}

/** Start a background delete; failures are left for the next start's sweep. */
export function removeInBackground(target: string, onDone?: (gone: boolean) => void): void {
  const p = removeTree(target).catch(() => false);
  pending.add(p);
  void p.then((gone) => {
    pending.delete(p);
    onDone?.(gone);
  });
}

/**
 * Make a folder disappear now and delete it in the background: rename it to a trash name next to it
 * (instant), then delete that. When the rename is refused (a running program holds a file inside),
 * fall back to a blocking delete so the caller can still reuse the path.
 */
export function moveAsideAndRemove(dir: string, fallback: () => void): "moved" | "removed" {
  if (!fs.existsSync(dir)) return "removed";
  const trash = `${dir}${TRASH_MARK}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    fs.renameSync(dir, trash);
  } catch {
    fallback();
    return "removed";
  }
  removeInBackground(trash);
  return "moved";
}

/** Delete trash folders a previous run left behind (it stopped before its background deletes ended). */
export function sweepTrash(parent: string): number {
  let items: string[];
  try {
    items = fs.readdirSync(parent);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of items) {
    if (!name.includes(TRASH_MARK)) continue;
    removeInBackground(path.join(parent, name));
    n++;
  }
  return n;
}

/** Wait for background deletes started so far (tests, shutdown). */
export async function settleRemovals(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
