# Progress

**Current phase:** Phase 2 (projects, memory, code index, multi-project scheduler) is built and passes its acceptance test in the container. It needs a run on Windows. Phase 1 was accepted on the owner's Windows PC.

_Last updated: 2026-10-31_

## Phase 2 acceptance criterion

| Criterion | Status |
|---|---|
| Two projects run tasks at the same time with correct, separate feeds and no cross-contamination | **Passes in the app** (Playwright `e2e/projects.spec.ts`: two imported projects, `/health` in one and `/version` in the other, both running at once, each feed and diff holds only its own work) and in the engine (`test/concurrency.test.ts`: overlapping runs, queued model calls, per-project feeds, change sets and task lists). **Not yet run on Windows.** |

## Completed in Phase 2

- **Projects:** New project wizard (name, folder, description, stack, git init), Import a folder or clone a git repository, Edit details, Duplicate (without installed packages), Export as .zip, Archive and restore, Remove from Depo (the folder is kept). Per-project settings: code index on/off, tasks at once, pause, commands to allow or block, most steps per task (ADR-0025).
- **Project dashboard** (Project tab): task counts, last test run, code index status with Rebuild, memory counts, recent changes, settings.
- **Memory** (Memory tab): project notes (Markdown) and global preferences, facts, decisions and preferences (agents add them with `remember`), and lessons learned from fixed test failures, shown to the agent the next time the same error appears (ADR-0023).
- **Code index:** tree-sitter symbols for 13 languages, repo map in the agent's prompt, `repo_map`, `find_symbol` and `semantic_search` tools, embeddings when an embedding model is installed, file watcher with incremental updates (ADR-0021, ADR-0022).
- **Scheduler:** one model queue for all projects with priorities, loaded-model preference, fairness between projects, max parallel (Settings → Model requests at once), Pause all and per-project pause (ADR-0024).
- **Running view** for every project with project names and the model queue; **Activity feed** filter "This project / All projects".
- Safety fix: removing a task copy unlinks the linked `node_modules`/`.venv` first, so the real folders can never be deleted through the link.

## Verification (development container, Linux x64)

| Check | Result |
|---|---|
| `bun run lint` (Biome) and `bun run typecheck` (4 packages, strict) | clean |
| Model gateway tests | 35 passed |
| Shared tests | 7 passed |
| Engine tests (adds projects, memory, code index, scheduler, two projects at once, lessons) | 142 passed |
| UI unit tests (Vitest) | 22 passed |
| End-to-end (Playwright, Chromium): app shell, Models, Chat (Phase 1 acceptance), Projects (Phase 2 acceptance, project lifecycle), axe WCAG 2.2 AA | 13 passed |

## Next steps

1. On Windows: `bun install` (new packages), then `bun run tauri:dev`; import two projects and run a task in each.
2. Download an embedding model (Models → Embedding) to turn on search by meaning.
3. Phase 3: the Manager and multiple agents per task.

---

# Phase 1 (accepted)

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

- Phase 2 Windows-specific parts still to confirm on a real PC: the recursive file watcher, git clone through Git for Windows, export to the Downloads folder.
- **Speed on modest PCs.** On a GTX 1650 + 25 GB RAM, `qwen3-coder:30b` reads prompts at ~10 tokens/s and writes at ~2 tokens/s, about 5× slower than Auto-Fit's estimate before a benchmark. Timeouts now allow 20 min for the first byte. Auto-Fit should model prompt-reading speed and recommend smaller coders on such PCs (Phase 2).
- Qwen3-Coder sometimes writes a malformed tool call that Ollama rejects ("XML syntax error"); the agent retries and then asks the model to try again.
- **Model catalog tags are unverified** because the container cannot reach ollama.com. Run `bun scripts/verify-catalog.ts` on a PC with internet.
- On Windows the database file can stay locked for a moment after `close()` (EBUSY when tests delete temp folders). Tests tolerate it; still to be confirmed fixed.
- Installers are unsigned, so SmartScreen warns on first run.
- The engine executable is large (~115 MB, embedded Bun runtime). Revisit in Phase 9.

## Next steps (Phase 1, done)

1. ~~On Windows: try the acceptance task with Ollama and a real coder model.~~ Passed.
2. Run `bun scripts/verify-catalog.ts` and fix any tags it reports.
