/** CLI wrapper used by the end-to-end tests: `bun scripts/fake-ollama.ts` (port from FAKE_OLLAMA_PORT). */
import { startFakeOllama } from "./fake-ollama-lib";

const { url } = startFakeOllama(Number(process.env.FAKE_OLLAMA_PORT ?? 47211));
console.log(`fake ollama on ${url}`);
