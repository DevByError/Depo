# Progress

**Current phase:** All nine phases are built. The 2026-11-07 upgrade (three rounds) adds the Team view, previews, agent playbooks, self-memory, structured logs and a new look (round 1), then steering, pull-request review, visual QA, the code map, the Project home, team replay, time estimates, universal search and git commits (round 2). Everything passes with scripted models in the development container; real-model runs happen on the owner's PC.

_Last updated: 2026-11-07_

## Upgrade round 2 (2026-11-07): steer, review like a pull request, see the app, understand the code

- **Steering:** send a note while an agent works; it is read at the next step (team: the Manager first, who may replan). Declining an approval asks why; the reason reaches the task and memory.
- **Pull-request review:** line comments in Diff Review (click, Shift+click for ranges, keyboard, Ctrl+Enter), "Request changes" sends them back; comments carry over to the next version or are marked outdated.
- **Visual QA:** agents call `check_page` to screenshot the running app at phone, tablet and desktop width, read console errors and failed requests and run axe; thumbnails in the work log; "Check this page" in Preview. Outside requests are blocked.
- **Link when ready:** the private copy starts by itself when changes are ready, Chat shows "Open the running app", and the Preview tab opens on it.
- **Code map:** import graph for TS/JS and Python (best effort for ten more languages), modules, cycles, entry points, hot spots, `code_map` for agents, an architecture diagram that redraws itself.
- **Project home:** stack, git state, quick actions, health cards, tasks, previews, decisions, memory, the code map.
- **Team replay and time estimates:** a scrubber rebuilds the team at any moment; estimates learned from this PC's real speed appear in the plan approval, Team, Plan and Chat.
- **Search and git:** Ctrl+K searches files, symbols, contents, tasks, decisions, memory and logs at once and can ask Depo; applied changes can be committed with a drafted conventional message; a History tab.
- **Polish:** the undo list in Diff Review folds away on narrow panels, sharper command matching, readable live command output, the bottom panel starts closed.
- **Verified:** engine 417 tests, UI 206, browser e2e 17 (axe in both themes); lint and types clean; the new screens checked in a browser in dark, light and a narrow window with the scripted model.

## Upgrade round 1 (2026-11-07): watch the team, run what it builds, deeper agents

- **Chat like Claude:** the view follows new content only while you are at the bottom (`lib/use-stick-to-bottom.ts`, "Jump to latest" pill); each turn's work is one line that you open; every step is one line with an agent chip and a plain summary, details on click (diffs for edits, exit code and output for commands); the Manager's plan shows as a numbered card; the composer grows, has a work-mode menu with descriptions, and Stop.
- **Team view (mission control):** new `decision` events (plan, plan approval, send back, escalate, review verdicts, results, ADRs, recommendation, release) and `team.timeline`; a Team tab with a live task graph, agent cards (state, current action, last decision, progress), and a decisions timeline; the Agents panel shows what each agent is doing.
- **Run and preview:** `preview/` detects how to start Node, Next, Vite, FastAPI, Flask, Django, static and monorepo projects, runs the real folder or a task's private copy on 127.0.0.1, checks readiness, keeps logs; a Preview tab with the link, Open in browser, Copy link, a phone/tablet/desktop viewer and live logs; "Preview these changes" in Diff Review; running previews in the sidebar. Agents get `start_preview`, `http_check` (loopback only) and `stop_preview` and smoke-test what they build.
- **Agent knowledge:** a playbook core per agent (definition of done, checklist, anti-patterns) plus 27 topics (FastAPI, Django, Node, Nest, Next, React, Tailwind, mobile, Postgres, MongoDB, Redis, auth, RBAC, testing, OWASP, performance, accessibility, Docker/CI, local AI/RAG and more) loaded within a budget that follows the model's context, and the `read_playbook` tool. Build plans get a production bar (auth, roles, validation, errors, pagination, seed data, tests, README, run script, accessible states, API docs) with testable criteria.
- **Self-memory:** after each finished task Depo saves facts it can read (stack, commands, ports, layout) and up to five items from a short background model summary, with dedupe, a cap, and secrets filtered; setting `memory.auto`; "auto" badge in Memory.
- **Logs:** structured JSON lines with components and task context, model call timing (time to first token, tokens/s), tool and command timing, `logs.query`/`logs.tail`/`logs.export` (diagnostics zip), a Logs tab, Activity feed filters and grouping, model performance in the Engine panel; setting `logs.level`.
- **Look:** slate and teal theme tokens (AA contrast checked on every surface), IBM Plex Sans, agent family colours (`lib/agent-color.ts`), a tool rail for tool screens, side panels that become drawers on narrow windows.
- **Fixes:** the hot-reload dev server crashed on a Node import (the UI now imports `@depo/model-gateway/contracts`); flaky message order; Windows paths in scanner output; Security reviews only code.
- **Verified:** engine 309 tests, UI 115, gateway 37, shared 7, browser e2e 17 (axe WCAG 2.2 AA in both themes); lint and types clean; a full-system team run and a FastAPI preview checked in a browser with the scripted model.

## Phases 6 to 9 (security, Agent Lab, building blocks, polish and release)

- **Phase 6:** `security/` (built-in rules, scanner wrappers, score, runtimes), tools `security_status`, `security_scan`, `performance_check`, Security panel, `scores.get` includes security.
- **Phase 7:** `agents/lab.ts` (versions, checks, A/B, promote gate, rollback, playground, import/export), migration v6, Agent Lab panel; the team runner reads the promoted manifests.
- **Phase 8:** `blocks/` (10 tested blocks), tools `list_blocks` and `use_block`, Blocks panel; fix, refactor, import and backend modes refined (reproduce first, baseline before and after, baseline scan, docs).
- **Phase 9:** command palette (Ctrl+K), notification bell and system notifications, first-run tour, team/notification/update settings, user-initiated update check, `scripts/set-version.ts`, release workflow, `docs/RELEASE.md`.
- **Also:** the final answer of a team run lists the security and UX scores and says when one blocks the release.
- **Verified:** engine 233 tests, UI 38, gateway 37, shared 7; lint and types clean; a contract test calls every new RPC over a real WebSocket; an integration test runs a team where the Security agent scans through the agent loop; the compiled sidecar was built, queried (schema 6, 15 agents, 10 blocks, 8 scanners, a real scan) and deleted.
- **Not verified here:** browser end-to-end tests (specs written, cannot run in the sandbox), real models, real scanners (parsers tested on sample output), the Windows installer build and signing, Rust code (unchanged).

## Phase 3 (agent team)

| Criterion | Status |
|---|---|
| A todo app (Next.js + FastAPI + PostgreSQL + login) goes through the full pipeline: brief, options, critique, design, diagrams, database, backend, integration, frontend, tests, security, performance, UX audit, deck, final review, docs | **Passes in the engine** (`test/team.test.ts`, scripted model plays all 15 agents; 17 plan nodes; dependencies respected; a different agent reviews each step; login work is reviewed by Security). |

Built: shared tool loop (`agent/loop.ts`), 15 agent manifests, Manager planning (structured output, validated, falls back to the standard pipeline), task graph executor with parallel branches, two-key reviews with a loop limit (5 by default), typed agent messages, project blackboard with ownership and history, plan approval, work modes (full, backend, frontend, ai, import, fix, refactor, ask, business), Plan Board and Agent Board, a work-mode picker in Chat, and the Claude-style chat (user bubble, flowing reply with the work folded, Markdown, streaming cursor).
Settings: `team.approve_plan`, `team.reviews` (all, key, off), `team.fix_loops`, `team.parallel`, `team.export_docs`.

## Phase 4 (design, diagrams, presentations)

| Criterion | Status |
|---|---|
| The todo project gets an ERD, an architecture diagram, a scored UX audit and an exportable deck | **Passes in the engine** (same acceptance test: `docs/diagrams/erd.mmd` and `architecture.mmd` checked by `render_diagram`, `scores/ux.json` from `record_ux_audit`, `docs/deck/deck.pptx` and `deck.html` in the change set). |

Built: Mermaid checker (syntax, balance, entities against the schema), font library (21 open-licence fonts, Arabic included, self-hosted through Fontsource) and type scale, screenshots and PDF through the PC's own Edge or Chrome in headless mode (verified here: PNG and PDF), vision review tool (uses the `vision` role), UX audit (Nielsen's ten heuristics, score out of 100, blocks the release below 60 or on any 1/5), decks as JSON, HTML (keyboard navigation, print CSS, strict CSP), PPTX (pptxgenjs) and PDF, and the Design, Diagrams (live Mermaid preview, editor, SVG and PNG export) and Slides panels.

## Phase 5 (skills, MCP, knowledge)

| Criterion | Status |
|---|---|
| A skill installed from GitHub measurably changes an agent's behaviour | **Passes in the engine** (`test/extensions.test.ts`: a fake GitHub serves a repository; the skill is previewed, installed, scanned, enabled; the same task then produces `handle_health()` instead of `health()`, and turning the skill off restores the old result). |

Built: skills (GitHub URL, folder or .zip; several skills per repository; pinned to the commit; update check; update; roll back to the previous version; per-agent and per-project assignment; Skill Creator with a local-model draft), a vetting scanner (dangerous commands, hidden or encoded commands, credential access, prompt-injection phrases, invisible characters, binaries, symlinks), progressive loading (only name and description in the prompt, `use_skill` and `read_skill_file` on demand); an MCP client (stdio and streamable HTTP on local addresses, tools scanned for hidden instructions, approval per tool unless read-only or trusted); knowledge packs (full-text search with SQLite FTS5, Markdown, text, HTML and PDF import, a catalog of 13 public packs installed by the user, results name pack and version); an offline OSV database (import from osv.dev or a local all.zip, version-range matching, `check_dependencies` tool); the Skills and Knowledge panels.

## Verification

| Check | Result |
|---|---|
| `bun run lint` and `bun run typecheck` (4 packages, strict) | clean |
| Model gateway tests | 37 passed |
| Shared tests | 7 passed |
| Engine tests | 190 passed |
| UI unit tests | 22 passed |
| Compiled sidecar (`bun scripts/build-engine.ts`) | builds; starts; serves the new API; FTS5 and migrations work in the compiled executable |

## Not verified yet

- **Browser end-to-end suite** (`bun run test:e2e`). It could not run in the build container: Edge could not reach localhost there. On the PC: `cd apps\desktop; bunx playwright install chromium; bun run test:e2e` (or set `PW_CHROMIUM_PATH` to msedge.exe). The chat layout changed, so a failure in `e2e/chat.spec.ts` is possible.
- **Real models.** Everything above used a scripted model. Run a Backend only task and a Full system task on the PC and see how `qwen3-coder` handles planning JSON and reviews; the plan falls back to the standard pipeline when the model cannot produce valid JSON, and `team.reviews = key` or `off` reduces the number of model calls on slow PCs.
- **Catalog addresses** (knowledge packs, models) were not checked against the internet from the build machine.
- **MCP servers** were tested with a test server over stdio and HTTP, not with real published servers.
- Phase 6 onwards is not started.

## Next steps

1. On Windows: `bun install`, `bun run tauri:dev`, try Backend only on a small project, then Full system.
2. Phase 6: Semgrep, gitleaks, OSV-Scanner, Trivy, Bandit, ZAP, k6, Lighthouse, local database runtimes.
3. Phase 7: Agent Lab. Phase 8: building blocks and the remaining modes. Phase 9: polish and release.

---

# Earlier phases

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
