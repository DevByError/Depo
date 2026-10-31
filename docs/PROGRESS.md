# Progress

**Current phase:** Phase 0 (Foundations) is complete in code and tested on Linux. Its Windows acceptance check (build the installer, install, open, see live heartbeats) is waiting on a Windows build. Phase 1 has not started.

_Last updated: 2026-10-31_

## Phase 0 acceptance criteria

| Criterion | Status |
|---|---|
| Installer builds on Windows | **Not yet run.** MSI + NSIS are configured, the Windows engine executable cross-compiles, and CI builds both installers on `windows-latest`. Run `scripts\build.ps1` on Windows (or push to GitHub) to produce them. |
| App opens | Verified on Linux: the real Tauri binary opened, spawned the engine sidecar, completed the token handshake and connected. |
| UI shows live heartbeat events from the engine | Verified: status bar, activity feed and Engine panel update every 2 s (e2e test + real desktop window). |

## Completed

- Monorepo (Bun workspaces), strict TypeScript, Biome, Husky, line-ending rules, CI workflow for Windows.
- `@depo/shared`: Zod schemas for events, JSON-RPC envelopes, the engine API, ids.
- `@depo/engine`: data folders with long-path support, JSON logging with rotation and redaction, SQLite (WAL) + Drizzle with embedded migrations and pre-migration backups, event bus with audit log, loopback WebSocket JSON-RPC server with token and origin checks, heartbeat, settings, ready handshake, parent/stdin/signal exit.
- `@depo/desktop`: Tauri 2 shell (sidecar spawn and supervision with restart budget, `engine_connection` command, tray, single instance, CSP, MSI/NSIS config with WebView2 bootstrapper); React 19 UI with the full layout, dark/light themes, live activity feed, agent board roster, engine health panel, problems list, settings dialog, keyboard shortcuts, resizable panels.
- Sidecar build script (`bun run build:engine`) for Windows x64/arm64, Linux and macOS targets.

## Verification (run in the development container, Linux x64)

| Check | Result |
|---|---|
| `bun run lint` (Biome) | clean |
| `bun run typecheck` (3 packages, strict) | clean |
| Engine + shared unit tests (`bun test`) | 37 passed |
| UI unit tests (Vitest) | 14 passed |
| End-to-end (Playwright, Chromium): connect, heartbeats, theme saved in engine, shortcuts, axe WCAG 2.2 AA in both themes | 5 passed |
| Rust unit tests (`cargo test`) + `cargo clippy` | 4 passed, no warnings |
| Real desktop app (Tauri debug build on a virtual display) | opened, engine handshake OK, engine killed → restarted on a new port and the UI reconnected, app exit → engine exited |
| Engine compiled for Windows (`bun-windows-x64`) | builds (115 MB single exe); not yet run on Windows |

## Known issues

- On Windows the engine's database file stays locked for a moment after `close()` (seen as an EBUSY warning when engine tests delete their temp folders). Tests tolerate it; fix properly in Phase 1 before backups, moves and shadow workspaces rely on it.

- Nothing has run on Windows yet (see acceptance table). Windows-specific paths are unit-tested with Windows inputs, but the installer, WebView2, tray and sidecar must be checked on a real Windows 10/11 machine.
- Installers are unsigned, so SmartScreen will warn on first run.
- When the desktop process is killed abruptly, the engine exits (no orphan) but may not write its "engine stopped" log line. Normal quit is unaffected.
- The engine executable is large (~115 MB) because it embeds the Bun runtime. Acceptable for now; revisit in Phase 9.
- The UI bundle is one 537 KB chunk; route-level code splitting arrives with Monaco/xterm in Phase 1.

## Next steps (Phase 1: single agent core)

1. Build and smoke-test the Phase 0 installer on Windows; fix anything Windows-specific.
2. Model gateway (`packages/model-gateway`): `ModelProvider` interface, Ollama adapter (streaming, tools, JSON schema, embeddings, cancel), llama.cpp and LM Studio via the OpenAI-compatible adapter.
3. Hardware profiler (GPU/VRAM via DXGI/nvidia-smi, RAM, CPU, disk, tokens/sec benchmark), model catalog, Auto-Fit planner with the reference profiles as tests, Models screen.
4. Tool layer (`packages/tools`): fs read/write/edit with path guards, ripgrep search, shell with Windows Job Objects and command policy, git.
5. Shadow workspace (git worktree or filtered copy), change sets, Diff Review with Monaco, atomic apply, checkpoints, undo.
6. One project + chat with a single agent. Acceptance: "add a /health endpoint to this FastAPI project" end to end.
