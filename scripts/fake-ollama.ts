/**
 * CLI wrapper used by the end-to-end tests: `bun scripts/fake-ollama.ts`
 * (port from FAKE_OLLAMA_PORT, optional delay per agent step from FAKE_OLLAMA_STEP_MS).
 */
import { startFakeOllama } from "./fake-ollama-lib";

const { url } = startFakeOllama(Number(process.env.FAKE_OLLAMA_PORT ?? 47211), {
  stepDelayMs: Number(process.env.FAKE_OLLAMA_STEP_MS ?? 0),
});
console.log(`fake ollama on ${url}`);
