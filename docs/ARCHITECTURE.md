# Depo architecture

Status: Phase 1 (single agent core). This document describes what exists now and the boundaries later phases build on. Planned parts are marked *(Phase N)*.

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

Server push: `{"jsonrpc":"2.0","method":"event","params": DepoEvent}` for every event.

## Events (packages/shared/src/events.ts)

`DepoEvent` = id, ts, seq (per engine run), projectId, taskId, agent (`name@version` or `engine`/`user`), type, text, details, durationMs, status, ephemeral.

Types are the spec's minimum list (`thinking`, `reading_file`, `running_command`, …, `checkpoint_created`) plus system types (`heartbeat`, `engine_started`, `engine_stopping`, `client_connected`, `client_disconnected`, `settings_changed`, `info`, `warning`). Heartbeats are ephemeral: broadcast every 2 s (setting `engine.heartbeat_ms`) but not stored.

Text and details are passed through the redactor (secret-looking keys, `.env`/`set`/`$env:` assignments, bearer tokens, JWTs, GitHub/AWS keys, private keys) before they are stored, logged or sent.

## Data

`%LOCALAPPDATA%\Depo\` (override with `DEPO_DATA_DIR`):

```
db\depo.db            app database (WAL)
db\backups\           automatic backups taken before migrations
logs\engine.log       JSON lines, rotated at 5 MB, 5 files kept
workspaces\ agents\ skills\ knowledge\ models\   created now, used from Phase 1+
```

Tables in Phase 0: `schema_migrations`, `settings`, `events`. The rest of the Section 18 model arrives with the features that use it, each as a new numbered migration.

Paths longer than 248 characters are prefixed with `\\?\` (or `\\?\UNC\`) before file system calls (`toLongPath`).

## UI (apps/desktop/src)

- `lib/engine-client.ts`: typed JSON-RPC client with reconnect/backoff, call timeouts, result validation.
- `lib/engine.ts`: the window's single client, wired to the stores.
- `store/engine.ts` (Zustand): connection status, engine info, event buffer (5,000 newest), heartbeat ring (60).
- `store/ui.ts` (Zustand): theme, tabs, panel sizes (saved in localStorage, guarded), filters.
- Layout: sidebar · center tabs (Chat, Files, Diff Review, Diagrams, Slides, Agent Lab, Skills, Models, Knowledge) · right panel (Activity, Agents) · bottom panel (Engine, Terminal, Problems, Test results) · status bar. Panels resize by drag or keyboard and give way on small windows.
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

## Coming next

- *(Phase 2)* projects, import, code index, project memory, multi-project scheduler.
