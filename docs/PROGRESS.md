# Progress

**Current phase:** Phase 1 (single agent core) is complete and accepted: on the owner's Windows PC (GTX 1650 4 GB, 25 GB RAM) the agent with `qwen3-coder:30b` on Ollama added the /health endpoint and its test, ran pytest (2 passed) and handed over a diff for review. Phase 2 has not started.

_Last updated: 2026-10-31_

## Phase 1 acceptance criterion

| Criterion | Status |
|---|---|
| User asks "add a /health endpoint to this FastAPI project"; the agent edits in the shadow workspace, runs the tests, shows a diff, and applies it on approval | **Passes in the app** (Playwright `e2e/chat.spec.ts`, 18 of 18 repeated runs) and in the engine (`test/agent.test.ts`). Both use the scripted fake Ollama and the real pytest on `scripts/fixtures/fastapi-demo`. **Also passed on Windows 11 with `qwen3-coder:30b` on Ollama (dev build).** |

## Completed in Phase 1

- **Model gateway** (`@depo/model-gateway`): Ollama (native API) and llama.cpp / LM Studio (OpenAI-compatible SSE) with streaming, tool calls, embeddings, model list, download with progress, delete, cancel, and friendly errors. Local and LAN addresses only (ADR-0015).
- **Hardware profiler**: GPU and VRAM (nvidia-smi, Windows registry, rocm-smi), RAM, CPU threads and flags (AVX2/AVX-512 through `IsProcessorFeaturePresent` on Windows), free disk, and a real tokens-per-second benchmark.
- **Model catalog** (32 models, importable JSON) and **Auto-Fit planner** for coder, reasoning, vision, embedding and fast roles in Quality, Balanced and Speed modes (ADR-0016).
- **Models screen**: this PC, runtimes, Auto-Fit plan with one-click download, per-role override, installed models with benchmark and delete, catalog import.
- **Tool layer**: read, list, find, search (ripgrep with a built-in fallback), write, edit (exact then whitespace-tolerant match), delete, run command, git status and diff. Path guards block escapes, `.git`, `.depo`, alternate data streams and symlink escapes.
- **Shell**: `cmd.exe` on Windows with Job Objects (kill on close, memory limit), process groups elsewhere; output capped with head and tail kept; secrets removed from the environment; command policy with approvals (ADR-0018).
- **Shadow workspace, change sets, Diff Review**: per-file and per-hunk apply, conflict detection, checkpoint before every apply, undo with conflict check (ADR-0017, ADR-0019).
- **Projects**: open a folder (native picker in the app), Files viewer.
- **Coding agent** (`coder@1.0.0`) with tasks, follow-ups, stop, retries, history shortening and live activity events (ADR-0020).
- **Chat screen**: task list, transcript with tool rows, live streaming reply and current step, approval cards, stop, "Review changes". The sidebar's Running section lists working tasks.

## Verification (development container, Linux x64)

| Check | Result |
|---|---|
| `bun run lint` (Biome) and `bun run typecheck` (4 packages, strict) | clean |
| Model gateway tests | 35 passed |
| Shared tests | 7 passed |
| Engine tests (database, API, events, hardware, models, tools, workspace, agent incl. acceptance) | 106 passed |
| UI unit tests (Vitest) | 15 passed |
| End-to-end (Playwright, Chromium): app shell, Models, Chat acceptance, axe WCAG 2.2 AA in both themes on each screen | 11 passed |

## Known issues

- **Nothing in Phase 1 has run on Windows yet.** Windows-only code is unit-tested where possible but needs a real run: Job Objects through FFI, `cmd.exe` quoting, registry GPU query, CPU-flag FFI, junctions for `node_modules`/`.venv`.
- **Speed on modest PCs.** On a GTX 1650 + 25 GB RAM, `qwen3-coder:30b` reads prompts at ~10 tokens/s and writes at ~2 tokens/s, about 5× slower than Auto-Fit's estimate before a benchmark. Timeouts now allow 20 min for the first byte. Auto-Fit should model prompt-reading speed and recommend smaller coders on such PCs (Phase 2).
- Qwen3-Coder sometimes writes a malformed tool call that Ollama rejects ("XML syntax error"); the agent retries and then asks the model to try again.
- **Model catalog tags are unverified** because the container cannot reach ollama.com. Run `bun scripts/verify-catalog.ts` on a PC with internet.
- On Windows the database file can stay locked for a moment after `close()` (EBUSY when tests delete temp folders). Tests tolerate it; still to be confirmed fixed.
- Installers are unsigned, so SmartScreen warns on first run.
- The engine executable is large (~115 MB, embedded Bun runtime). Revisit in Phase 9.

## Next steps

1. On Windows: `bun install`, `bun run check`, then try the acceptance task with Ollama and a real coder model on a copy of `scripts/fixtures/fastapi-demo`.
2. Run `bun scripts/verify-catalog.ts` and fix any tags it reports.
3. Phase 2: multiple projects, import, code index, project memory, multi-project scheduler.
