# Depo architecture

Status: Phase 5 (agent team, design, skills, MCP, knowledge). This document describes what exists now and the boundaries later phases build on. Planned parts are marked *(Phase N)*.

## Processes

```
┌──────────── depo-desktop.exe (Tauri 2, Rust) ─────────────┐
│ window · tray · single instance · CSP                      │
│ EngineState: per-launch token, port, restart budget        │
│   │ spawns + supervises                                    │
│   ▼                                                        │
│ ┌── WebView2: React UI ─────────────┐                      │
│ │ invoke("engine_connection") ──────┼─► {port, token}      │
│ │ WebSocket ws://127.0.0.1:<port>/rpc?token=…              │
│ └───────────────────────┬───────────┘                      │
└─────────────────────────┼──────────────────────────────────┘
                          │ JSON-RPC 2.0 requests / responses
                          │ + `event` notifications (push)
┌─────────────────────────▼──── depo-engine.exe (Bun) ───────┐
│ API server (auth, origin check, Zod validation, dispatch)  │
│ Handlers (pure: params + context → result)                 │
│ Event bus ──► audit log (SQLite)  ──► subscribers          │
│ Settings repo · Logger (JSON lines, rotation, redaction)   │
│ SQLite (WAL) via bun:sqlite + Drizzle, embedded migrations │
└────────────────────────────────────────────────────────────┘
```

### Startup handshake

1. Tauri generates a 256-bit random token and spawns the sidecar with `DEPO_ENGINE_TOKEN`, `DEPO_ENGINE_PORT=0`, `DEPO_PARENT_PID`, `DEPO_EXIT_ON_STDIN_CLOSE=1`.
2. The engine opens the database (migrating, with a backup first if needed), binds `127.0.0.1` on a random free port and prints one line on stdout:
   `DEPO_ENGINE_READY {"port":51234,"pid":4242,"version":"0.1.0"}`. Nothing else is ever written to stdout.
3. Tauri parses the line, stores the port and emits `engine://ready`.
4. The UI calls the `engine_connection` command (waits up to 20 s) and opens the WebSocket. On every reconnect it asks again, because a restarted engine has a new port.

### Lifetime and crash safety

- The engine exits when stdin closes, when the parent PID disappears, or on SIGINT/SIGTERM/SIGBREAK. Tauri also kills it on app exit.
- If the engine dies, Tauri restarts it (at most 5 times per minute), emits `engine://exited`, and the UI shows "Reconnecting", reconnects, and records a warning in the activity feed.
- Every non-ephemeral event is written to SQLite before any client sees it, so the audit log survives crashes.

## Engine API (packages/shared/src/rpc.ts)

All methods have Zod schemas for params (validated by the engine) and results (validated by the client). Unknown params are rejected.

| Method | Purpose |
|---|---|
| `system.ping` | Liveness check |
| `system.info` | Version, runtime, platform, PID, data folder, database path, schema version |
| `events.recent` | Audit log query: limit, project, types, text search (LIKE with escaping) |
| `events.emit` | UI records an `info` or `warning` in the audit log |
| `settings.get` / `settings.set` / `settings.all` | Key/value settings (JSON values, dotted lowercase keys), with defaults |

| `hardware.get` / `hardware.profile` | Saved hardware profile; profile this PC again |
| `models.*` | Runtimes (`providers`, `providers.set`), `installed`, `catalog` and `catalog.import`, Auto-Fit `plan`, role `assignments` and `assign`, downloads (`pull`, `pull.cancel`, `pulls`), `delete`, `benchmark` |
| `projects.list` / `projects.open` / `projects.forget` | Projects (one open at a time in the UI) |
| `files.list` / `files.read` | Read-only project browsing |
| `tasks.list` / `tasks.get` / `tasks.send` / `tasks.cancel` / `tasks.retry` | Coding tasks and their transcripts; `tasks.retry` runs a failed or stopped task's last message again |
| `approvals.list` / `approvals.respond` | Commands waiting for the user |
| `changes.list` / `changes.get` / `changes.apply` / `changes.discard` | Change sets from the shadow workspace; apply whole files or chosen hunks |
| `checkpoints.list` / `checkpoints.restore` | Undo an apply |
| `logs.query` / `logs.tail` / `logs.components` / `logs.info` | Engine log search (level, levels, component, text, task, project, since/until, paging with `before`, byte cap) read backwards over `engine.log` and the rotated files; live lines after a cursor from an in-memory ring |
| `logs.export` / `logs.openFolder` | Diagnostics .zip in Downloads (logs, system info, hardware, redacted settings, recent events, installed models, model timings, scheduler); show the logs folder in Explorer |
| `models.stats` | Recent model calls (tokens/s, time to first token, errors) and a per-model summary, in memory for this run |
| `tasks.steer` | A note for a working task, read at the agent's next step (team: the Manager first) |
| `review.comments.list` / `.add` / `.update` / `.remove`, `review.requestChanges` | Line comments on a change set in Diff Review, and sending them back as a follow-up |
| `team.events` / `team.eta` | A task's stored events in pages (for replay); time estimates learned on this PC |
| `search.everything` | Ctrl+K search over files, symbols, file contents, tasks, decisions, memory and logs, with a time budget per scope |
| `git.status` / `git.draftCommit` / `git.commit` / `git.log` / `git.show` / `git.setIdentity` | Commit applied change sets (only the applied files, never pushed) and read history |
| `qa.check` / `qa.get` / `qa.list` / `qa.screenshot`, `preview.pin` | Page checks in a headless browser and their screenshots; keep an automatic preview running |
| `codemap.get` / `codemap.file` / `codemap.repo` | Module and file import graph, cycles, entry points, hot spots; detected stack and git state |
| `terminal.run` / `.read` / `.kill` / `.list` / `.history` | The owner's Terminal: one command per run in the project or a task's private copy, output after a line number, stop, recent runs, per-project command history |
| `tests.runs` | Test runs from agents and the Terminal, with counts and parsed failures |
| `diagnostics.run` / `.latest` / `.runtime` | Compiler and linter checks with the tools already installed, the newest result, crashes from previews and page checks |
| `blueprints.list` / `.get` / `.create` | Production-grade starting points; create a new project folder from one |
| `readiness.get` / `readiness.run` | The readiness report for a task's latest change set; run its tests, page check or security scan again |
| `references.image` | The stored picture of a design reference (an owner's picture, or the screenshot of a linked page); `tasks.send` takes `references` (up to 4 pictures and 2 links) and transcript user items carry what Depo read from them |

Server push: `{"jsonrpc":"2.0","method":"event","params": DepoEvent}` for every event.

## Events (packages/shared/src/events.ts)

`DepoEvent` = id, ts, seq (per engine run), projectId, taskId, agent (`name@version` or `engine`/`user`), type, text, details, durationMs, status, ephemeral.

Types are the spec's minimum list (`thinking`, `reading_file`, `running_command`, …, `checkpoint_created`) plus system types (`heartbeat`, `engine_started`, `engine_stopping`, `client_connected`, `client_disconnected`, `settings_changed`, `info`, `warning`) and the upgrade types `decision`, `preview_started`/`preview_stopped`, `memory_updated`, `owner_note` (a steering note; details `{ noteId, state, readBy? }`), `committed` (a git commit of applied files), `rendering_screenshot` (a page check; thumbnails and counts in details) and `terminal_output` (ephemeral lines from a Terminal run, with a sequence number per run). Heartbeats are ephemeral: broadcast every 2 s (setting `engine.heartbeat_ms`) but not stored.

Text and details are passed through the redactor (secret-looking keys, `.env`/`set`/`$env:` assignments, bearer tokens, JWTs, GitHub/AWS keys, private keys) before they are stored, logged or sent.

## Logs (packages/engine/src/logger.ts, logs/)

Every line is JSON: `ts`, `level` (debug/info/warn/error), `component` (api, agent, team, tasks, tools, models, scheduler, workspace, index, db, events, security, …), `msg`, then optional `projectId`, `taskId`, `agent`, `durationMs`, `err` ({ name, message, stack }) and other fields. `logger.child({ component, taskId })` adds bindings; `withLogContext({ taskId, projectId, agent }, fn)` (AsyncLocalStorage) adds them to every line logged inside, so model calls and scheduler lines carry the task without being told. Shared code without a logger uses `getLogger({ component })`, which writes through the engine's logger. Lines are redacted, batched (50 ms; errors at once; flushed on exit) and appended synchronously; rotation is size-based (5 MB, 5 files). Level: `DEPO_LOG_LEVEL`, else the `logs.level` setting (default `info`, applied at once).

Instrumented: model calls (provider wrapper in ModelManager: provider, model, prompt/reply tokens, time to first chunk, total time, tokens/s, errors; retries in the tool loop), tool calls (tool, ok, duration, first line of the result), commands (command, exit code, duration), scheduler queue and run times, task and team node lifecycle, API failures and invalid params.

## Data

`%LOCALAPPDATA%\Depo\` (override with `DEPO_DATA_DIR`):

```
db\depo.db            app database (WAL)
db\backups\           automatic backups taken before migrations
logs\engine.log       JSON lines, rotated at 5 MB (engine.1.log … engine.5.log kept)
workspaces\ agents\ skills\ knowledge\ models\   created now, used from Phase 1+
references\<taskId>\  design references: refs.json plus the pictures and screenshots
```

Tables in Phase 0: `schema_migrations`, `settings`, `events`. The rest of the Section 18 model arrives with the features that use it, each as a new numbered migration.

Paths longer than 248 characters are prefixed with `\\?\` (or `\\?\UNC\`) before file system calls (`toLongPath`).

## UI (apps/desktop/src)

- `lib/engine-client.ts`: typed JSON-RPC client with reconnect/backoff, call timeouts, result validation.
- `lib/engine.ts`: the window's single client, wired to the stores.
- `store/engine.ts` (Zustand): connection status, engine info, event buffer (5,000 newest), heartbeat ring (60).
- `store/ui.ts` (Zustand): theme, tabs, panel sizes (saved in localStorage, guarded), filters.
- Layout: sidebar · center tabs (Project, Chat, Files, Diff Review, Memory, Diagrams, Slides, Agent Lab, Skills, Models, Knowledge) · right panel (Activity, Agents) · bottom panel (Engine, Terminal, Problems, Test results) · status bar. Panels resize by drag or keyboard and give way on small windows.
- Tabs whose features belong to later phases say which phase, instead of showing fake content.
- Theme tokens in `styles.css`, dark default, light alternative; all text meets WCAG AA (checked by axe in e2e).
- Shortcuts: Ctrl+B sidebar, Ctrl+J bottom panel, Ctrl+L activity panel, Ctrl+, settings, arrow keys across tabs.

## Security model (Phase 0)

- The engine listens on loopback only, requires the per-launch token (constant-time compare) and rejects browser origins other than Tauri's and localhost dev servers.
- The token lives in the Rust process and the WebView's memory only; it is not written to disk or logs.
- CSP restricts the WebView to its own assets, IPC and `ws://127.0.0.1:*`.
- JSON payloads are capped at 1 MB; every request is schema-validated; method lookup ignores prototype keys.

## Phase 1: the single agent core

```
Chat (tasks.send) ─► TaskManager ─► ModelManager.resolve("coder") ─► model-gateway ─► Ollama / llama.cpp / LM Studio
                         │  tool loop (≤ 40 steps)
                         ▼
                    tools (read · list · find · search · write · edit · delete · run_command · git)
                         │  all paths resolved inside ──►  workspaces/<task>/   (shadow copy)
                         │  run_command ─► policy ─► ask? ─► ApprovalCenter ─► approval card in Chat
                         │                └► cmd.exe in a Job Object (Windows) / process group
                         ▼
                    ProjectService.collectChanges ─► change set ─► Diff Review ─► apply (checkpoint first) ─► undo
```

- **Model gateway** (`packages/model-gateway`): `ModelProvider` interface, Ollama and OpenAI-compatible adapters, catalog, hardware schema, Auto-Fit planner. No cloud adapters exist.
- **ModelManager** (`engine/src/models`): runtimes, installed models, downloads with progress events, benchmark, role assignments; `resolve(role)` returns the provider and model for a role (manual choice, else the Auto-Fit pick if it is installed).
- **Tools** (`engine/src/tools`): each tool has a JSON schema for the model and returns text; `executeTool` never throws. Every tool emits activity events (`reading_file`, `editing_file`, `running_command`, `testing`, `test_result`, …).
- **Workspace** (`engine/src/workspace`): projects, shadow copies with a hash manifest, change sets (`change_sets` table, jsdiff hunks), checkpoints (`checkpoints` table + copied files under `checkpoints/<id>/`).
- **Agent** (`engine/src/agent`): project detection and system prompt, text tool-call parser, `TaskManager` (tasks and messages tables). Streaming text goes out as ephemeral `thinking` events with a `jobId`, which the UI merges into one live line.
- **UI**: Chat (task list, transcript, live row, approvals, stop), Files, Diff Review (selection per file and hunk, History with Undo), Models. Engine events with a `taskId` refresh task and approval queries.

Tables added in migration 2: `projects`, `tasks`, `messages`, `change_sets`, `checkpoints`.

## Phase 2: projects, memory, code index, scheduler

```
            ┌──────────── ProjectRegistry ── create · import (folder / git clone) · rename · archive · duplicate · export · remove
UI ─► API ──┼──────────── MemoryStore ────── project-memory.md · facts · lessons · global memory
            ├──────────── CodeIndexer ────── watcher ─► tree-sitter symbols ─► chunks ─► embeddings (via scheduler, background)
            └── tasks.send ─► TaskManager ── system prompt + memory + repo map
                                   │ every model call
                                   ▼
                             ModelScheduler ── one queue for all projects: chat > task > background, loaded model first,
                                   │            round-robin between projects, max parallel, pause all / per project
                                   ▼
                             model-gateway ─► Ollama / llama.cpp / LM Studio
```

- **ProjectRegistry** (`engine/src/projects`): project lifecycle and per-project settings (`project_settings`: index on/off, tasks at once, pause, command allow/deny lists, max steps). Git runs with prompts turned off; clones time out after 15 minutes. `zip.ts` is a small streaming zip writer for export.
- **MemoryStore** (`engine/src/memory`): Markdown files under `<data>/projects/<id>/` and `_global/`, the `memory_facts` table, lessons with error signatures, and `contextFor()` for prompts.
- **CodeIndexer** (`engine/src/codeindex`): `code_files` (hash per file), `code_symbols`, `embeddings`; `repoMap`, `findSymbols`, `search` (symbols + semantic). Agent tools: `repo_map`, `find_symbol`, `semantic_search`, `remember`.
- **ModelScheduler** (`engine/src/scheduler`): `run(request, fn)` wraps each model call; emits ephemeral `queued` events while a job waits.
- **Separate feeds:** every task event carries its `projectId`; the Activity feed shows "This project" (plus engine-wide events) or "All projects" with a project tag.
- **UI:** Project tab (dashboard: tasks, last test run, code index with Rebuild, memory counts, recent changes, project settings), Memory tab (project and global notes, facts, lessons), New project and Import dialogs, project menu (edit, duplicate, export, archive, remove), archived list, Running section for every project with the model queue and Pause all, and "Model requests at once" in Settings.

Tables added in migration 3: `project_settings`, `memory_facts`, `code_files`, `code_symbols`, `embeddings`; `projects` gained `description`, `stack`, `origin`, `archived_at`.

## Coming next

- *(Phase 6)* security and testing depth (Semgrep, gitleaks, OSV-Scanner, Trivy, Bandit, ZAP, k6, Lighthouse).
- *(Phase 7)* Agent Lab: versions, evaluations, A/B, promote and roll back.
- *(Phase 8)* building blocks library and the remaining refinements of every work mode.
- *(Phase 9)* onboarding, command palette, notifications, auto-update, signed installers.

## Agent team (Phases 3 to 5)

```
packages/engine/src/
  agent/loop.ts        the tool loop shared by every agent
  agent/tasks.ts       task manager: single coder, or hands the task to the team
  agents/manifests.ts  15 manifests (mission, tools, reviewers, blackboard sections)
  agents/team.ts       Manager plan, task graph executor, reviews, loop limits, summary
  agents/blackboard.ts versioned shared notes + typed messages
  design/              mermaid check, fonts, browser (screenshot, PDF), deck, UX audit, service
  skills/              SKILL.md parsing, scanner, install/update/rollback, assignment
  mcp/                 MCP client (stdio, HTTP) and manager
  knowledge/           packs (FTS5), catalog, OSV
  tools/design-tools.ts render_diagram, list_fonts, render_screenshot, review_screenshot, make_deck, record_ux_audit
  util/                zip reader, GitHub download
```

Flow of a team task: `tasks.send(mode)` creates the shadow workspace, then `TeamRunner.run` asks the Manager for a plan, optionally waits for the user's approval, runs ready nodes in parallel (limit `team.parallel`), reviews each node with a different agent, loops on blocking findings up to `team.fix_loops`, and finishes with the Manager's summary and one change set for Diff Review. Per-run extras (skills, MCP tools, knowledge search, dependency check) are merged by one provider in `engine.ts` and given to both the coder and the team agents.

Tables added: migration 4 (`blackboard`, `blackboard_history`, `agent_messages`, `tasks.mode`, `tasks.plan`) and migration 5 (`skills`, `skill_assignments`, `mcp_servers`, `knowledge_packs`, `knowledge_fts`, `osv_vulns`, `osv_meta`).

## Playbooks and automatic memory

```
packages/engine/src/
  playbooks/core/*.md    one core per agent (and the coder): mission, definition of done, checklist, what to avoid
  playbooks/topics/*.md  27 topics with a small header (title, summary, agents, triggers, when)
  playbooks/index.ts     loading, topic choice, budgets, the read_playbook tool's answers
  playbooks/plan.ts      the production bar: planning guide for the Manager and extra criteria per task
  agent/stack.ts         stack detection (languages, frameworks, databases, package manager, test and run commands, ports)
  memory/auto.ts         memory.auto: facts and a model summary after each task, preferences from reasons
```

Knowledge loads in steps so small local models are not flooded. Every system prompt has the agent's core and a one-line list of topics. Topic sections are added only when the model's context allows it (none up to 8k tokens, 1 up to 16k, 2 above), chosen by the request text, the detected stack and the agent's own field, and trimmed at a heading or paragraph. Anything else is one `read_playbook` call away (`{topic}`, `{query}`, or nothing to list). Build plans (full, backend, frontend, ai) get the production bar: accounts, roles, validation, errors, pagination, seed data, tests, README and run script, accessible UI states, OpenAPI, as testable criteria. Reviewers check work against the owner's definition of done.

After a single or team task ends in review or done (never cancelled or declined), `AutoMemory` saves facts read from the files (stack, package manager, the test command that passed, run command, ports, layout; keyed `auto:*` in `memory_facts.signature`), then asks the fast or coder model, at background priority, for at most 5 items as JSON. Items are cleaned, checked for secrets, deduplicated (same normalised text or token Jaccard of 0.8 or more updates instead of adding), stored with source `auto`, capped at 40 per project, and announced with one `memory_updated` event. A reason given when declining a command or plan, or when discarding changes, becomes a preference; a discard also re-reads the facts from the real project. Setting `memory.auto` (default on) turns it off. No migration: `source` is a text column.

## Previews (packages/engine/src/preview/)

```
  recipes.ts        how to start a folder: Node (npm/pnpm/yarn/bun; Next, Vite, CRA, servers), FastAPI/Flask/Django
                    (venv interpreter first), static sites, monorepo frontend + backend; a saved command wins
  manager.ts        start / restart / stop, readiness over HTTP, 2000-line redacted log ring, states, cleanup
                    when the engine stops, a task copy is removed or a project is removed
  ports.ts          a free port on 127.0.0.1
  static-server.ts  built-in static server (MIME types, no path traversal)
  http-check.ts     loopback-only HTTP checks for agents
```

A preview runs the project's real folder or a task's private copy, so new code can be run and tried before it is applied. Commands go through the command policy and run contained (`startShell` in `tools/shell/run.ts`, Job Objects on Windows), bind to 127.0.0.1, and get telemetry-off variables. RPC: `preview.targets`, `preview.detect`, `preview.start`, `preview.stop`, `preview.restart`, `preview.list`, `preview.logs`; events `preview_started`, `preview_stopped`. Agent tools: `start_preview`, `http_check`, `stop_preview` (Backend, Frontend, Integration, Testing and the single coder). The Tauri CSP allows `frame-src` for loopback so the Preview tab can embed the app.

## Team view (decisions and timeline)

Agents' decisions are `decision` events (`details.kind`: plan, plan_approval, send_back, escalate, release, review, result, adr, recommendation) with plain text. `team.timeline { taskId }` (`agents/timeline.ts`) builds per-agent stats (state, current action, done/total, reviews, time, last decision) and the decision list from the plan and the events table. The UI merges live events with that snapshot: `TeamPanel.tsx` (header stats, `PlanGraph` layered DAG from `lib/dag-layout.ts`, `AgentCard`, `DecisionTimeline`) and the compact `AgentBoard`.

## UI shell

Tool rail (left edge: projects toggle, tool screens as icon tabs, theme, settings) | Sidebar (projects, running tasks and previews) | Centre (work tabs: Project, Chat, Team, Plan, Files, Diff Review, Preview) | Right panel (Activity, Agents); bottom panel (Engine, Terminal, Problems, Test results, Logs, History), closed at first (Ctrl+J). Below 1180 px the right panel and below 860 px the sidebar become drawers. Theme tokens live in `styles.css` (slate surfaces, teal accent, agent family colours, all text AA on every surface); per-agent colour and initials come from `lib/agent-color.ts`. Scroll following: `lib/use-stick-to-bottom.ts` (chat, any DOM list) and `lib/use-follow-list.ts` (virtualised lists).

## Steering and line comments (round 2)

A note sent while a task works (`tasks.steer`, an `owner_note` event, `ChatItem.steer` for its state) waits in the task's inbox and is read only at a step boundary: the top of the agent loop and before a final answer. In a team run the Manager reads it first, replans if needed (a `plan`/`replanned` decision) and passes it to the active agents through the blackboard. Notes still unread when the run ends normally become a follow-up; otherwise they are dropped. A reason given when declining an approval goes to the running task as a note and to self-memory.

Diff Review comments (`review_comments`, migration 8) belong to a change set and a line range (old or new side). Status: open, addressed (by the change, an agent or the owner) or outdated. "Request changes" sends the open comments, with the quoted code, as one follow-up; on the next version a comment carries over when its quoted code still matches exactly.

## Team replay and time estimates (round 2)

`team.events` pages a task's stored events (noise skipped, text clipped). `lib/team-replay.ts` is one reducer for live and replay, with a checkpoint every 200 events, so the scrubber under the Team header can rebuild the graph, agent cards and decisions at any moment; markers show decisions, reviews, changes, send-backs and errors. "Share moment" copies a local `depo://team/...` reference.

`agents/eta.ts`: `EtaTracker` times work, review and fix steps and single-agent tasks from the event bus (approval waits subtracted, only finished nodes learn); `EtaService` keeps the newest 40 samples per agent and kind (`eta_samples`, `eta_models`, migration 7) and the model speed, scales old samples by today's speed, and falls back to other agents' history, then a first guess from model speed that says so. `simulateSchedule` honours `team.parallel` along the critical path. Estimates appear in the plan approval, the Team header, node cards, the Plan board and the Chat header.

## Search (round 2)

`search/service.ts` runs seven scopes in parallel, each with a time budget in ms (files 500, symbols 300, content 900, tasks 300, decisions 300, memory 250, logs 700); a scope that runs out returns what it has and says so. Files: fuzzy match on a 20 s cached file list. Content: ripgrep (fixed strings, smart case, killed on timeout) or a built-in scanner. Symbols from the code index; memory and logs work without a project. The palette shows commands at once and engine results after a 160 ms pause; prefixes `>` commands, `@` symbols, `#` tasks and decisions, `/` files, `?` ask; the last row asks Depo (`tasks.send` in ask mode). Results open where they live (`store/nav.ts`): a file at its line, a task in Chat, a decision in Team, a memory item, a log filter.

## Git (round 2)

`git/repo.ts`, `message.ts`, `service.ts`. Every git command goes through `classifyCommand` and the project's command rules (a deny rule wins) and runs contained. A commit stages only the files Depo applied for that change set (`--pathspec-from-file` with literal pathspecs), so the owner's other work is untouched; it can first create a `depo/<slug>` branch, uses the repo's own identity (or one set for this repo with `git.setIdentity`), rolls back staging and branch on failure, and never pushes. The message is a conventional commit drafted by the local model at background priority, with a template fallback. UI: "Commit these changes" in Diff Review after an apply, the History bottom tab, the branch in the status bar and on the Project home.

## Visual QA and automatic previews (round 2)

`design/cdp.ts` is a small DevTools Protocol client: it starts the installed Chromium-family browser headless with a temporary profile (Job Object on Windows, process group elsewhere, always killed and cleaned), and drives pages over a loopback WebSocket. Requests that leave the PC are blocked and reported. `design/page-check.ts` loads a page at phone, tablet and desktop widths, runs up to 10 steps (click, type, press, wait_for), looks for expected text, takes screenshots and thumbnails, collects console errors and failed requests, and runs axe-core 4.14 (`design/axe.ts`). Checks are stored under `<copy>/.depo/qa/<id>/` (left out of change sets) or `<data>/qa/<projectId>`; images are served only after their path is validated. `QaService` runs one check at a time, emits `rendering_screenshot`, and optionally asks the vision model for a review at background priority (agent checks only). Agent tool `check_page` (Frontend, UI/UX Design, Testing, Integration, single coder); serious findings feed the UX audit.

`preview/auto.ts`: when a task ends ready for review, its private copy starts in the background if Depo knows how (setting `preview.auto_start`, default on; skipped when packages need installing or a preview already runs), and stops when the change set is applied or discarded unless pinned. Chat shows "Open the running app"; the Preview tab opens on the running copy.

## Code map and Project home (round 2)

`codeindex/analyse.ts`, `resolve.ts`, `graph.ts`, `codemap.ts`. The indexer reads imports from the syntax tree for TS/JS (ES imports, re-exports, `require`, dynamic `import()`; `import type` kept apart so it never makes a cycle; tsconfig/jsconfig paths with `extends`, workspace packages, `.js`→`.ts`, index files) and Python (absolute, relative, packages, `src/` layouts), and best effort for Go, Rust, Java, Kotlin, C#, PHP, Ruby, C, Dart, Vue/Svelte/Astro, CSS and HTML. Results live in `code_imports` and new `code_files` columns (`branches`, `entry`, `map_version`; migration 9) and follow the file watcher. The map groups folders into at most 40 modules, finds runtime import cycles, entry points (declared or guessed) and hot spots (most imported, largest, most branches, changed most in the last 400 commits, read-only and cached 10 minutes). Agent tool `code_map` (Thinking, Reasoning, Backend, Frontend, Integration, Enhancement; the single coder is told to use it first; Import mode's study step starts with it). A Mermaid module diagram is redrawn 4 s after code changes settle and kept in Depo's data folder (`projects/<id>/code-map.mmd`, listed in Diagrams as generated; "Save a copy to the project" writes `docs/diagrams/code-map.mmd`).

The Project tab is the project home: header (stack, branch with changed/ahead/behind, last commit), quick actions (New task, Preview, Scan, Rebuild index), health cards (last test run with a sparkline, security score, UX score, code size by language), tasks, running previews, latest decisions, memory highlights, recent changes, code index, the code map (graph with a table alternative, module and file drill-down, Open in Files), and project settings folded at the bottom.

## Speed on a modest PC (round 3)

Models stay loaded: every call carries the `models.keep_alive` setting (default `30m`; Ollama `keep_alive`, LM Studio `ttl`; `-1` means until Depo closes, and then the engine unloads what it used). llama.cpp gets `cache_prompt`. `ModelManager.contextFor` picks one context size per model (the largest any assigned role needs, capped by `maxContextFor` from VRAM plus RAM), and the `tuneProvider` wrapper applies it to every call to that model, so roles that share a model never force a reload. System prompts are ordered for prefix reuse: what never changes first (role, how to work, rules, playbook core), then the project, then memory, the repo map and the task's topics; the top-level listing is sorted. The scheduler prefers the loaded model (20 s age limit) and holds background work that would swap the model while chat or task work waits or runs, and for 3 s after (released after 20 s). `ModelWarmup` (setting `models.preload`, default on) loads the first step's model at background priority when a task starts, unless `/api/ps` shows it already loaded. Model stats add load time, cold loads, prompt reading speed, reused prompt tokens and the context length; the Engine panel says when most time goes to loading, and Settings has a "Model speed" section.

Runaway replies: every agent step asks for at most `MAX_REPLY_TOKENS` (8192) tokens, one-shot vision calls for 1500 (Ollama's own default is no limit). `agent/repetition.ts` watches the stream every 256 characters for a block of lines, or a run of characters, repeating at the end; the loop then stops that reply only (its own AbortController, linked to the task's), keeps the text up to the first copy, runs each tool call once (`uniqueCalls`), tells the model why, and carries on. Three stopped replies in a row end the task with a plain reason. A reply cut off at the length limit with no tool call is never taken as the final answer.

## Terminal, Test results and Problems (round 3)

`terminal/service.ts` runs one command per run in the project folder or a task's private copy. The command policy judges it (a deny rule refuses; "ask" counts as approved because the owner typed it) and it runs contained like agent commands (Job Object on Windows, process group elsewhere, a time limit, an 8 GB memory cap, no keyboard input, an environment with telemetry and browser opening switched off). Output streams as ephemeral `terminal_output` events and stays in a ring of the newest 2000 lines (colour codes turned into a tone per line, secrets redacted) so a UI that reconnects asks for lines after N. Runs and the per-project history live in `terminal_runs` and `terminal_history` (migration 10). `terminal/test-runs.ts` gathers test runs from agents' `test_result` events and Terminal runs the policy classifies as tests; `test-parsers.ts` reads failures from pytest, unittest, jest, vitest, bun test, go test and cargo test.

`diagnostics/plan.ts` looks at the project and its sub-projects and plans only checkers already installed (tsc, Biome, ESLint, ruff, compileall, mypy, pyright, go vet, cargo check); nothing is installed. `diagnostics/service.ts` runs them one after another through the command policy, keeps the newest result per folder or task copy (`diagnostics_latest`), and `runtime.ts` adds crashes from preview logs and console errors from the newest page check. Agents call the `diagnostics` tool; the readiness report reads `latest`. UI: Terminal (target picker, history with Up/Down, Stop, recent runs), Test results (runs with counts, failures linked to files, Run again), Problems (grouped by file, Check now), and "Fix with an agent" on any failure, which drafts a follow-up for the task or a new task with the evidence.

## Blueprints (round 3)

`blueprints/` holds three whole, tested starting points: a FastAPI service (accounts, roles, an example resource, pytest), a React web app (Vite, TypeScript, Tailwind, sign-in, a protected layout, list, detail and form, Vitest) and a full-stack app (both, wired together). Templates are `.tpl` files generated into TypeScript by `scripts/gen-blueprint-templates.ts`; `render.ts` fills distinctive tokens (`__DEPO_NAME__`) and escapes the owner's project name for each place it goes. `blueprints.create` writes a new folder, makes a first git commit when git is allowed, and registers the project. Agents get `list_blueprints` and `use_blueprint`; `plan.ts` makes the first build step start from the closest blueprint only when the project is empty and the request does not name another stack. The single coder's prompt gets the same hint. UI: "Start from" cards in New project, and a Blueprints section in Blocks.

## Readiness report (round 3)

`readiness/checks.ts` turns stored facts into checks (Tests, Code checks, Security, UX, Page check, Plan criteria, Reviews, Open comments, Risky changes, Size), each pass, warn, fail, not run or stale, and a verdict: ready, ready with warnings or not ready, with up to three reasons in words. Tests are stale when an edit is newer than the last run. `ReadinessService` reads only events, blackboard scores, stored page checks, the plan, comments and the change set; it makes no model calls. At review it records a `decision` of kind `readiness`; in a team the reviewer brief and the release line include it. `readiness.run` runs the tests (command from memory, the stack, or the agents' last command; through the policy), a page check (starting the copy if needed) or a security scan of the copy that never replaces the project's own score. UI: the Readiness card under the Chat review banner, a pill in Diff Review and Team, a badge on Project home.

## Code reading (round 3)

`lib/highlight/` colours code with highlight.js 11 in a module Web Worker (idle time on the main thread if no worker starts). The core and each grammar load on first use; results are cached by language and content hash; above 300 KB or 8000 lines nothing is coloured ("Large file: shown without colours"). Tokens are rendered as text, never HTML. `styles/syntax.css` defines 15 token colours per theme, each at least 4.5:1 on every code background including added and removed lines (unit test). Highlighting is used in Files, Diff Review (per hunk, old and new sides apart), the work log, History and chat code blocks (language label, Copy). The Files tree opens to any file requested through `requestFile`; the viewer has a "Line N" gutter (click, Shift+click, drag, keyboard), flashes the requested line, and a "Selected lines" toolbar offers "Ask about this" (an ask-mode task with the quoted code), "Change this" (a new task with the composer prefilled through `store/composer.ts`) and "Copy path:line".

## Design references

The owner can paste, drop or pick a picture (PNG, JPEG, WebP, GIF; up to 4, 5 MB each, bigger ones shrunk in the UI to 2400 px) or add a link (up to 2) and ask for the same look. `tasks.send` carries them as `references`; the WebSocket accepts messages up to 16 MB for this. `references/service.ts` checks each picture's bytes against its type, saves it under `references/<taskId>/`, and studies it when the task starts running:

- **Pictures:** the headless browser draws the picture on a canvas (640 px, no smoothing, so flat colours stay exact) and returns the pixels. `palette.ts` buckets and merges them (CIE Lab, ΔE < 5), keeps the main colours, a text colour or two and the saturated accents, and guesses roles: background, surface, border, text, muted, primary, accent, success, warning, danger.
- **Links:** `url.ts` adds `https://`, allows only http(s) without credentials and refuses hosts on the local network; a page on this PC (localhost) uses the usual local rules. `capture.ts` opens the page through `CdpPage` with a gate (`OutsideRequestGate`) that lets each request through only when its host resolves to a public address, denies downloads, waits for the network to settle, reads computed styles (fonts, heading and body sizes, corner radii, the main button, CSS colour variables, content width) and takes a desktop and a phone screenshot. Opening a pasted link is the only time Depo goes online.
- **Vision:** when a model is assigned to the vision role, it gets the picture with the measured palette and returns short notes about layout, typography and shapes, plus role corrections ("Role: #14b8a6 is the primary"). Without one, only colours and styles are used and the reference says so.

`brief(taskId)` turns what was read into a deterministic text (theme, colours with roles, fonts, sizes, corners, the main button, tokens, notes, then a work order: set the tokens first, check the page, compare). It is appended to the user message that carried the references in the model's history, and in a team written to the blackboard as `design-reference.md` and added to the request. The pictures are copied into the task's private copy under `.depo/references/` (never part of a change set). The `compare_to_reference` tool (ui-ux-design, frontend, integration, enhancement agents and the single coder) compares a screenshot of the agent's page with the reference: measured colour differences and, with a vision model, what looks different and how to fix it. UI: a paperclip menu (Picture…, Website link…), paste and drop on the composer, a "Copy the look of <host>" offer for a typed link, chips before sending, and under the sent message a card per reference with the picture, colours with their roles and "What Depo saw".

## Build, run and test by itself

A request like "a Next.js front end in fe, a Bun back end in be, MySQL, sign up / sign in / sign out, look like this picture" now ends with a running app, a test database with demo data and links, without the model having to know how.

- **Starting point without a model (`agent/kickstart.ts`):** before any agent runs, `blueprintFor` picks a blueprint for an empty project (`next-bun-mysql` when the request names Next.js and a Bun server, unless it names another database or server) and writes it into the private copy; when the message carried a design reference, `references/theme.ts` turns its measured colours into CSS tokens (`themeFromReference`: page and card the right way round, text and links raised to WCAG AA on the card, a primary deepened until a white label reads, a page gradient when the picture paints its page in colour) and writes them between `/* depo:theme:start */` and `/* depo:theme:end */` in every stylesheet that has the markers. The agent's prompt (or the team brief) starts with "Already done by Depo" and the folder list, the run and test commands and how to extend it.
- **The `next-bun-mysql` blueprint:** `fe/` Next.js (app router, sign up, sign in, sign out, a protected home, the theme block in `globals.css`), `be/` a Bun + TypeScript API (`Bun.serve`, `Bun.password`, sessions in an httpOnly cookie, mysql2, migrate and seed scripts printing the demo sign-ins, `bun test`), `run.cmd` / `run.sh`, a README. Ports come from `PORT=` in `.env` (`recipes.ts` `envPort`): the API on 4000, the site on 3000.
- **Test database (`devdb/`):** `DevDatabaseService` runs MariaDB (or MySQL) for each project on 127.0.0.1 under `<data>/devdb/<projectId>/` with a random 20-character password for an `app` user and one database named after the project. It finds the server in Depo's tools folder, on PATH, in Program Files, XAMPP or Laragon; on Windows, when none is found, it asks once (a command approval) and downloads the portable MariaDB 11.4.5 zip from archive.mariadb.org, checked against the published SHA-256. `writeEnv` writes `DATABASE_URL` and the `DB_*` keys into the app's `.env` files. Agents use the `dev_database` tool (start, status, sql, reset, stop); the owner has a "Test database" card on Project home and `devdb.*` RPC methods. The servers stop with the engine.
- **The finish line (`agent/finish.ts`):** when the single coder says it is done and it changed files, Depo installs every part's packages through `run_command` (the command policy and approvals apply), starts the test database and runs the app's migrate and seed scripts when the app uses MySQL, restarts the task's previews the way review does, waits for them (120 s) and opens the home page in the headless browser. Problems (a failed install, an app that does not start with its last output lines, console errors, failed requests) go back to the model as a user message, at most twice (`FINISH_ROUNDS`). Then a report starting with "Depo ran the app." is added after the answer: the links, the database and its password, the demo sign-ins and anything still broken. A team run gets the same check after the release line. Setting `agent.finish_line` turns it off.
- **No-show model replies:** a reply that describes steps for the owner ("open a terminal and run…") instead of calling tools gets a "do it yourself" nudge (`describesStepsForOwner`); pretend `cd` calls and several calls in one fence are understood (`textcalls.ts`); `edit_file` on a missing file and malformed arguments get a hint with the exact expected shape (`ARGUMENT_HINTS`); `.depo/` is protected with a message that says where to write instead.
- **Bun stand-in (`tools/shell/run.ts`):** when `bun` is not on PATH, commands get `bun` and `bunx` launchers that run the engine exe itself with `BUN_BE_BUN=1`, so a Bun app runs on a PC that never installed Bun.
- **Runtime crashes (`models/revive.ts`):** a model call that fails because Ollama refused the connection, dropped it (ECONNRESET) or crashed (runner terminated, CUDA out of memory) waits for the runtime's health check (90 s), starts `ollama serve` if a local Ollama is not running, and retries; after two crashes the task asks for half the context (never below 4096) and compresses its history. Stray socket errors (ECONNRESET, EPIPE…) no longer end the engine process (`main.ts`).
- **Permissions:** an approval can be given once, for the rest of the task, or for the whole project ("Allow all in this project", which turns on the project's `fullAccess`). Full access approves commands, installs and downloads by itself; applying changes to the real project still always asks. The Projects settings have the same switch.

## Follow-ups and weak models

Built after the owner's run with qwen2.5-coder:3b, where the first build worked and the follow-up "make it responsive" started from zero and told the owner what to do.

- **The copy, not the index (`agent/followup.ts`):** the code index describes the project folder; the agent works in its private copy, which after the starting project or a few turns looks nothing like it. The system prompt's file list is `copyRepoMap`: the index's map with files the copy no longer has left out and files only the copy has added with their top-level declarations (regex, not a parser), under "# Files in your copy now".
- **Follow-up messages:** when the last message is a new request after earlier answers (`isFollowUp`), `compactEarlierTurns` replaces the earlier turns with one user message: each earlier request with its answer (Depo's own prompts and made-up answers left out), the copy's files (`copyTree`, trimmed to the prompt budget: all files, then sub-folders with counts, then top folders), the design brief when it still applies, the new request and "build on the files that are there". The stored transcript stays whole. The "Working on" event names the new request.
- **Stop after the call (`agent/loop.ts`, `agent/textcalls.ts`):** text tool calls are read in tiers (tagged, fenced, bare objects); the first tier with a known tool wins, so a fenced `package.json` no longer hides a bare call. While streaming, `firstTextCallEnd` is checked every 80 characters; 400 characters after a complete call the reply is cancelled, cut at the end of the first group of adjacent calls (`firstCallGroupEnd`), those calls run, and the model is told to make one call at a time. `inventsToolResult` catches a reply made of `<tool_response>` blocks: two nudges, then `withoutInventedResults` keeps the model's own words.
- **Loops that do nothing:** a look-only tool (read_file, list_dir, find_files, search, repo_map, find_symbol, semantic_search, git_status, git_diff, read_playbook, bb_read) called again with the same arguments, with no edit or command in between, gets a note the second time and only the note from the third. An `edit_file` identical to one already applied, on a file whose hash is unchanged since, is skipped with "you already made this exact edit" and a "Depo skipped it" event. `write_file` refuses a folder path ("fe/") and placeholder content ("Folder created.") with a message that says folders are created by themselves (`refuseFolderOrPlaceholder`).
- **Depo's own agents:** the starting project and theme are written as `starter@depo`, the finish line runs as `tester@depo` with its own tool context, and the readiness decision is the reviewer. The finish line also counts the starting project as a change, runs every part's tests (`testCommands`, through the project's package manager: `packageManager` in package.json, then the lockfile; Bun as `bun run test`), and runs once more, without fix rounds, when the coder stops at the step limit.
- **Team tab for one agent (`components/team/SingleCrew.tsx`):** a single-agent task shows four lanes, Depo starter, Coder (with its model), Depo tester and Depo reviewer, each with its state (waiting, working, done, problem, not needed), last step, step count and time, and the steps newest first. Events come from the live list and `events.recent` for older tasks.
- **Preview at real sizes (`components/panels/PreviewPanel.tsx`, `store/preview.ts`):** phone 390×844, tablet 820×1180 and desktop 1440×900 render the page at that size and scale it down to fit (`fitScale`, ResizeObserver on the frame's area once it appears), with the size and scale shown; "100%" shows it unscaled with scrolling. An earlier page check starts folded to one line so the screen stays in view. The preview follows the front end first (an API's JSON page only when nothing else runs) and other running parts have "Show here".
- **Role fallbacks (`models/manager.ts`):** an Auto-Fit vision pick must look able to see (`canSee`: catalog capability, else the name), a hand-picked one is tried; a model that refused a picture is kept in `models.blind` and never gets the vision role again. An Auto-Fit pick for a non-coder role that is not installed resolves to nothing, so callers use the coder's model.
- **Code pasted as text (`agent/codedump.ts`):** while a coder's reply streams, `dumpInProgress` (over 3000 characters, a code block of 15+ lines, no tool call) stops it, at most three times a run; a final answer with an 8+ line block while nothing changed is caught by `isCodeDump`, at most twice. `filesFromDump` turns complete, path-labelled blocks for new files into `write_file` calls that run like the model's own; blocks for existing files are listed so the nudge (`dumpNudge`) says to read and `edit_file` them. The history keeps the reply's words before the first block. `withoutStrayResultTag` drops a bare `<tool_response>` that opens an ordinary sentence.
- **Broken and made-up calls (`agent/textcalls.ts`, `agent/loop.ts`):** `parseLoose` tries the text as it is, with raw control characters escaped, with bad escapes fixed (`fixBadEscapes`: `\'` to `'`, others kept as a backslash), then the repairs below. A reply with no readable call is checked with `unknownToolCalls` (objects with a name and arguments that are not Depo tools and have no alias), `looksLikeToolCall` and unfinished file blocks; each adds to `unreadable`, which only a call that runs resets (see Small models for the limit). The nudge for an unreadable call carries `textCallProblem` (the first JSON error, also for `<tool_call>` tags).
- **File blocks (`agent/blocks.ts`):** `searchReplaceBlocks` reads SEARCH/REPLACE blocks with their path (the nearest line above, a fence's info string, or the previous block's path); `blockCalls` turns them, and fenced blocks labelled with the path of a new file, into `edit_file` / `append_file` / `write_file` calls in text order. The loop reads blocks in every reply of an agent that can edit, after the JSON calls (block calls run first); new labelled files only with `fileBlocks`, in a stopped paste, or in a code answer while nothing changed. Older long replies are trimmed by `compressHistory` like old tool output. When calls came from blocks, the history keeps the reply as written plus one user note from `blockResults`; the transcript gets the calls and tool messages as usual. `dumpInProgress` takes the root and leaves replies with SEARCH markers or a new labelled file alone. `append_file` (`tools/fs-tools.ts` `appendFileTool`) adds after a blank line and keeps the file's line ends.
- **Repairs and aliases (`agent/textcalls.ts`, `agent/aliases.ts`, `tools/args.ts`):** `parseWithRepairs` adds `balanceBrackets`, `pythonish`, `missingCommas` and `fixInnerQuotes` (also tried before control-character escaping); `openTail` reads a call never closed; `callParts` reads the OpenAI function shape and flat arguments. `aliasFor` maps a made-up name with clear arguments to a real tool; text calls return `renamed` (call id → made-up name) and native calls go through `withAliases`; the result starts with `aliasNote`. `normalizeArgs` runs in `runTool` and on every call in the loop, so dedupe keys and paths are consistent.
- **Small models (`agent/small.ts`, `agent/prompt.ts`, `agent/tasks.ts`, `agent/loop.ts`):** `isSmallModel` (≤ 4B from `modelBillions`); the coder run lists the installed models once, gives a small model `SMALL_MODEL_TOOLS` (plus skill and MCP extras), `codingSystemPrompt({ small })` with `SMALL_MODEL_STEPS`, `fileBlocks: true`, and `stepUp` from `pickStepUp` when `agent.step_up` is on. In the loop, `unreadableReply` handles every reply with no runnable call: `BROKEN_STUB` in the history, `retryAdvice` by attempt, temperature 0.2, `model` switched to the step-up model at the third (`STEP_UP_AT`), back after a call runs; limit `MAX_UNREADABLE` (4) or 5 with a step-up model.
- **Retry (`agent/tasks.ts`, `agent/followup.ts`, `components/panels/ChatPanel.tsx`):** `TaskManager.retry` marks the task in `retrying` and launches it; `run` reads the mark first and passes the history through `forRetry`. `RetryBar` under a failed or stopped run calls `tasks.retry`.
- **Finish guards (`tools/sqlcheck.ts`, `tools/index.ts`, `agent/request-check.ts`, `agent/loop.ts`):** `schemaWarnings` appends `foreignKeyProblems` for a changed `.sql` file to the write, edit and append results. `append_file` calls `mustHaveRead` for a file that exists and refuses `onlyComments` text; the loop's repeated-edit key covers it. In the loop, an empty final answer gets a nudge (`emptyAnswers`, 2); `checkDone` (from `tasks.ts`: `missingParts(request, ws.root)`, where `requestedParts` reads routes and Next.js page list items and the copy's source files and `app` folders are checked) adds `notDoneNote` while the list shrinks (`doneStalls`, `MAX_DONE_NUDGES` 6). After a `beforeFinish` retry, `reportOpen`, `lastReport` (`reportSummary`) and `callsSinceReport` track whether the model changed anything; an answer with no call replaces itself with a stub, gets the report again at temperature 0.2 and steps up with `stepUpFor = "report"` (kept until the larger model answers, then back to the owner's model before the finish line runs again).
- **Schema repairs and the request report (`tools/sqlcheck.ts`, `agent/blocks.ts`, `readiness/checks.ts`):** `createTables` finds CREATE TABLE statements with their options and `;`; `newTables` keeps those for tables a file does not have, `withoutExistingTables` drops the others, `matchForeignKeyTypes` retypes integer foreign key columns of added tables. `append_file` on `.sql` goes through `sqlAppend` (no read needed). `blockCalls` reads Git conflict markers, turns a `.sql` SEARCH/REPLACE whose old text is not in the file (`looselyIncludes`) or a labelled `.sql` paste into one `append_file` of its new tables. The loop steps up for a stalled missing part (`partStepUps`, `MAX_PART_STEP_UPS` 2) and goes back at the larger model's answer. `tasks.ts` adds a "Not finished:" message when `missingParts` is not empty at the end; the readiness service adds `requestCheck(requestStatus(prompt + latest user message, copy))` as the "request" check.
- **Hung runners (`models/revive.ts`):** an HTTP 500 saying Ollama cannot reach its runner is a crash, a timed-out connection is dropped; on a crash `chatWithRetry` calls the provider's `unload` before waiting and retrying.
- **Test database recovery (`devdb/service.ts`, `devdb/procs.ts`):** MySQL runs without `--skip-name-resolve` (its only root is root@localhost) and with its own `--secure-file-priv` folder. Server processes are listed by command line (PowerShell `Win32_Process` on Windows, `/proc` on Linux, `ps` elsewhere) and matched by the data folder (`runsOn`). A start that times out kills the process tree and any server left on the folder; a start finds and stops a leftover when `server.pid` is still there, and retries once when the log says the files are locked (checked every 2 s while waiting). A database that will not start is `blocked` at the finish line: reported to the owner, never sent to the model.
