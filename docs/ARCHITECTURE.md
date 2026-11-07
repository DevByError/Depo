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
| `tasks.list` / `tasks.get` / `tasks.send` / `tasks.cancel` | Coding tasks and their transcripts |
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

Server push: `{"jsonrpc":"2.0","method":"event","params": DepoEvent}` for every event.

## Events (packages/shared/src/events.ts)

`DepoEvent` = id, ts, seq (per engine run), projectId, taskId, agent (`name@version` or `engine`/`user`), type, text, details, durationMs, status, ephemeral.

Types are the spec's minimum list (`thinking`, `reading_file`, `running_command`, …, `checkpoint_created`) plus system types (`heartbeat`, `engine_started`, `engine_stopping`, `client_connected`, `client_disconnected`, `settings_changed`, `info`, `warning`) and the upgrade types `decision`, `preview_started`/`preview_stopped`, `memory_updated`, `owner_note` (a steering note; details `{ noteId, state, readBy? }`), `committed` (a git commit of applied files) and `rendering_screenshot` (a page check; thumbnails and counts in details). Heartbeats are ephemeral: broadcast every 2 s (setting `engine.heartbeat_ms`) but not stored.

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

