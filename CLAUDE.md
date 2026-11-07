# Depo: project memory for Claude

Read this first every session. Update "Status log", "Next" and "Known issues" at the end of every work session.

## What Depo is
A fully local, multi-agent AI coding studio for Windows (Tauri 2 + React UI, Bun engine sidecar, SQLite, local models via Ollama / llama.cpp / LM Studio). The user describes software; 15 specialist agents plan, design, build, test, secure and document it in a private copy of the project; the user reviews a diff and approves before anything touches real files. No cloud models, no accounts, no cost per token. **Depo itself has no login.** It builds systems that can have one.

**The full design is `Depo-System-Description.docx` (v1.0, 4 Nov 2026) at the repo root. It is the source of truth for scope and behaviour.** Other docs: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR-0001 to 0033), `docs/PROGRESS.md`, `docs/PHASE-0.md`.

## Principles to keep
- Local and free; proposed, never imposed (shadow workspace + Diff Review + checkpoint + undo); visible work (activity feed + audit log); tools decide correctness (tests/lint/types, not model claims); Windows first; best model that fits, step down by adding smaller steps and more checking.
- Agents talk through the Manager and a project blackboard with typed messages. Two-key rule: a different agent reviews each output (a setting: `team.reviews` all/key/off). Fix loops capped (default 5).
- Small-model reliability matters: read-before-edit, exact search/replace edits, text tool-call recovery, tests as ground truth, planning JSON validated with a standard-pipeline fallback.
- Skills, MCP servers and downloaded packs are untrusted until scanned; the user enables them.

## Repo layout
- `apps/desktop`: Tauri shell (src-tauri) + React UI (src/components/panels = one file per screen) + Playwright e2e
- `packages/engine/src`: `agent/` (loop.ts shared tool loop, tasks.ts), `agents/` (manifests, team runner, blackboard), `design/`, `skills/`, `mcp/`, `knowledge/` (packs + OSV), `tools/` (index.ts registry, design-tools.ts), `util/` (zip, github), plus db, api, projects, workspace, memory, codeindex, scheduler, models
- `packages/model-gateway`: runtimes, catalog, Auto-Fit, hardware. `packages/shared`: Zod contracts (rpc.ts, agents.ts, extensions.ts)
- `scripts/`: dev, build-engine, setup/build ps1, fake-ollama (scripted model for e2e), fixtures
- Commands: `bun run check` (lint + typecheck + tests), `bun run dev`, `bun run tauri:dev`, e2e in apps/desktop: `bun run test:e2e`

## Phase plan (each phase must pass its acceptance test before the next starts)
| # | Scope | Status |
|---|---|---|
| 0 | Foundations | Done |
| 1 | Single agent core | Done, accepted on Windows (qwen3-coder:30b) |
| 2 | Projects, memory, code index, scheduler | Done |
| 3 | Agent team: 15 manifests, Manager plan, blackboard, typed messages, reviews, loop limits, Plan/Agent Boards | Done (engine acceptance test with a scripted model) |
| 4 | Design systems, fonts, Mermaid diagrams + editor, screenshots + vision review, UX audit, decks (HTML/PPTX/PDF) | Done |
| 5 | Skills (GitHub/zip/folder, scan, assign, update/rollback), MCP client, knowledge packs (FTS5), offline OSV | Done |
| 6 | Security + testing depth (Semgrep, gitleaks, OSV-Scanner, Trivy, Bandit, ZAP, k6, Lighthouse, local DB runtimes) | Done |
| 7 | Agent Lab (versions, evals, A/B, promote/rollback, playground, sharing) | Done |
| 8 | Building blocks library (roles/permissions, auth, ...) + all work modes refined | Done |
| 9 | Polish and release (onboarding, palette, notifications, update check, release workflow) | Done (signing and in-app install untested) |

## Status log (newest first)
- 2026-11-07 (upgrade round 3 of 3): built 5 upgrades in parallel worktrees and merged: speed on a modest PC (keep-alive, one context per model, prompt order for prefix reuse, scheduler model affinity, warm-up, load stats), real Terminal + Test results + Problems (diagnostics from installed checkers, `diagnostics` tool, Fix with an agent), blueprints (FastAPI, React, full stack; `list_blueprints`/`use_blueprint`), readiness report (`readiness.get`/`run`, card, pill, badge), syntax highlighting (highlight.js in a worker) + Files line actions. Migration 10 terminal_diagnostics. e2e uses one temp root per run. Engine 534, UI 338, gateway 46, e2e 17.
- 2026-11-07 (upgrade round 2 of 3): assessed Depo against the strongest coding agents (docs/UPGRADE-ROUNDS.md), built 11 upgrades in 5 parallel worktrees and merged: steering notes, decline reasons, line comments + Request changes, team replay, ETA learned on this PC, Ctrl+K universal search, git commits of applied files + History tab, CDP visual QA (`check_page`, axe), auto preview + "Open the running app", code map + auto diagram + `code_map` tool, Project home. Migrations 7 eta_history, 8 review_comments, 9 code_map. Engine 417, UI 206, e2e 17.
- 2026-11-07 (upgrade round 1 of 3; user asked: make everything advanced, 3 rounds of build, assess, 10x ideas, test; no questions): pulled the user's Phases 3-9, fixed 3 flaky/OS tests and e2e (first-run tour covered screens). Built in parallel worktrees and merged: Claude-style chat (stick-to-bottom, one-line expandable steps), Team view (decision events, `team.timeline`, task graph, agent cards, decisions timeline), Preview (run recipes, preview manager, Preview tab, agent tools `start_preview`/`http_check`/`stop_preview`), playbooks + production bar + auto memory, structured logs + Logs tab, new theme + tool rail + drawers. Engine 309, UI 115, e2e 17.
- 2026-11-07 (worker: playbooks and memory): every agent has a playbook core (definition of done, checklist, anti-patterns) plus 27 on-demand topics loaded within context budgets and through the `read_playbook` tool; build plans get a production bar; reviewers check the definition of done. Depo now remembers by itself after tasks (`memory.auto`, auto badge in Memory, toggle in Settings, optional reason on Discard). Engine 256 tests, UI 45.
- 2026-11-06 (autonomous run 2; user asked: finish the project phase by phase, check each, then re-test everything and enhance): Phases 6-9 built, each committed after `bun run check`. Then a full re-test: contract test over WebSocket, team integration test (Security agent scan through the loop), compiled sidecar smoke test (deleted after). Enhancements: final team answer lists security/UX scores and release blockers; `agents.list` returns promoted versions; leaked test temp folders fixed; release workflow hardened (pinned actions, publish job without secrets); `performance_check` URL allow-list after a security review. Engine 233 tests, UI 38, gateway 37, shared 7.
- 2026-11-06 (autonomous run; user asked: do phases 3-5 without stopping, build/test loop, delete big test environments, they will review after): chat redesigned like Claude (user bubble, flowing reply, Markdown, streaming cursor, work folded). Phases 3, 4, 5 built and tested (engine 190 tests, UI 22, gateway 37, shared 7; lint and typecheck clean; compiled sidecar builds and serves the new API; build output and temp test folders deleted). A security review of the deck HTML found an injectable font name: fixed (strict font regex + CSP) and tested.
- Before that (git log): small-model hardening (read-before-edit, tolerant text tool calls, unclosed-call repair, copied line numbers, retry unreadable calls); tests checked before accepting "done"; Stop works on tasks left "working" by an old engine.

## Next
1. The user reviews on their PC: `bun install`, `bun run tauri:dev`; welcome tour, then try Backend only and Full system with a real model (expect prompt tuning; use `team.reviews = key` on the 4 GB GPU).
2. Run the browser e2e (`apps/desktop`, `bun run test:e2e`; `PW_CHROMIUM_PATH` = msedge.exe if needed). Specs `phase345.spec.ts` and the new tabs (Security, Agent Lab, Blocks, palette, tour) were not run. The tour opens on first launch and may cover older specs: set `ui.onboarded` in them if so.
3. Real scanners: install Semgrep/Gitleaks etc. and compare `security_scan` against their raw output; check the Agent Lab with a real model (judge checks need the reasoning model).
4. First release rehearsal: follow `docs/RELEASE.md` with a pre-release tag; add signing secrets; consider the Tauri updater later.
5. Ideas not built: embeddings for knowledge packs, Auto-Fit that models prompt-reading speed, Agent Lab checks that run the whole tool loop, trimming history in bigger steps so prefix reuse survives past 70% of the context.
6. Check round 3 on Windows with real models: keep-alive and `/api/ps` fields on the installed Ollama, the speed gain, Terminal runs in a Job Object, the checkers' output parsers on real tool output, and a blueprint-based build with qwen2.5-coder.

## Known issues
- Slow on modest hardware (GTX 1650 4 GB: ~2 tok/s writing with qwen3-coder:30b); Auto-Fit should model prompt-reading speed and prefer smaller models. A full-system run on such a PC will take hours; use Backend only, `team.reviews = key`, and a small coder.
- Qwen3-Coder sometimes emits malformed tool calls Ollama rejects; the loop retries and nudges.
- Catalog tags (models) and knowledge-pack GitHub paths are unverified. MCP was tested with a test server only. Scanner parsers were tested on sample JSON, not on real tool output.
- Tests that connect to local fake servers can time out (ETIMEDOUT) when the PC is heavily loaded (for example a big disk scan); rerun.
- Installers unsigned; engine exe ~138 MB; DB file may stay locked briefly after close on Windows (EBUSY in tests, harmless).
- Windows quirk: a Python/JS edit script that writes files with default newlines produces CRLF; the repo is LF (`.gitattributes`). Biome does not fix line endings; use `newline='\n'`.

## Working rules for Claude on this repo
- Check the system description before designing anything new; do not invent agent roles or flows that contradict it.
- Run `bun run check` before saying something is done; report failures honestly. Tests must pass with scripted models; never claim a real-model result you did not see.
- Commit only when the user asks (during the autonomous run the user asked for work to be committed per phase). Keep this file current.
- Delete temp test environments you create (`%TEMP%\depo *`, build outputs in `src-tauri/binaries`).
- In this sandbox, shell heredocs mangle backslash escapes (`\n`); write scripts with the Write tool, then run them.
