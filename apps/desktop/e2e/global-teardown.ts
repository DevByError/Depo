import { rmSync } from "node:fs";
import { E2E_TMP } from "../playwright.config";

/**
 * Remove the run's temp root (engine data and project copies). Best effort: on Windows a file the
 * engine still holds open makes this fail, and a leftover temp folder is not worth failing a run.
 */
export default async function globalTeardown() {
  try {
    rmSync(E2E_TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    // Left for the OS temp cleanup.
  }
}
