# Phase 0: Foundations

This file answers the three questions the master prompt asks before Phase 0, and records how each Phase 0 task was done.

## (a) Understanding of the product in 10 points

1. **Depo is a Windows desktop app (Tauri 2)** that turns a plain-language request into working software, using a team of specialist AI agents instead of one assistant.
2. **Everything runs locally and costs nothing.** Models run through Ollama, llama.cpp or LM Studio on the user's PC (or another PC on their LAN). There are no cloud model providers, no accounts and no telemetry.
3. **The engine is separate from the UI.** A Bun/TypeScript sidecar holds all logic (orchestrator, agents, tools, model gateway, scheduler) behind a typed JSON-RPC API, so a CLI can reuse it later.
4. **Fifteen agents with clear roles** (Manager, Thinking, Reasoning, PM, Design, Diagram, Backend, Frontend, Database, Integration, AI Integration, Testing, Security, Enhancement, DevOps/Docs) work through an orchestrator, a task DAG and a shared project blackboard, never free-form chat.
5. **Safety comes from the shadow workspace.** Agents edit and test a copy of the project; the user reviews diffs and approves per file or hunk; every apply makes a checkpoint and can be undone.
6. **Quality comes from verification, not trust.** Two-key reviews, build/test/fix loops with limits, compilers and tests as ground truth, and best-of-N on weak hardware make a slow PC produce slower, not worse, results.
7. **Hardware-aware model choice.** A profiler and Auto-Fit planner pick the strongest catalog model each role can run (quantization, GPU+RAM split, MoE, CPU), and a GPU-aware scheduler shares one model across agents and projects.
8. **Everything is visible.** Every action is an event in a live activity feed, an agent board and a plan board, and is stored in a searchable audit log.
9. **Extensible and upgradeable.** Claude-compatible `SKILL.md` skills from GitHub (vetted before use), MCP servers, offline knowledge packs, and versioned agents with evals, A/B comparison, promotion and rollback.
10. **Many projects at once,** each with its own workspace, memory, settings and history, delivered as a full system (brief, design, diagrams, code, tests, security audit, UX audit, deck, docs) or in focused modes (backend only, frontend only, AI integration, fix, refactor, ask).

## (b) Final repository tree

Packages marked *(Phase N)* are created in the phase that first needs them, so the repo never holds empty placeholders.

```
depo/
  apps/
    desktop/                 Tauri 2 shell + React UI
      src-tauri/             Rust: window, tray, single instance, sidecar lifecycle, installer config
      src/                   React 19 UI (layout, panels, stores, engine client)
      e2e/                   Playwright end-to-end tests
  packages/
    shared/                  Zod schemas: events, JSON-RPC envelopes, the engine API, ids
    engine/                  Bun sidecar: API server, event bus, SQLite + migrations, logging, paths
    model-gateway/           (Phase 1) Ollama / llama.cpp / LM Studio adapters, hardware profiler, Auto-Fit
    tools/                   (Phase 1) fs, search, shell (Job Objects), git, test, lint; later security, browser, diagram, slides
    memory/                  (Phase 2) code index (tree-sitter + embeddings), project memory
    agents/                  (Phase 3) default agent manifests, prompts, eval suites
    ui-kit/                  (Phase 3) shared React components once a second UI surface needs them
    skills/                  (Phase 5) skill loader, GitHub installer, vetting
    mcp/                     (Phase 5) MCP client
    blocks/                  (Phase 8) building blocks library (RBAC, auth, …) per stack
  docs/                      ARCHITECTURE, DECISIONS, PROGRESS, this file
  scripts/                   dev.ts, build-engine.ts, setup.ps1, build.ps1
  .github/workflows/ci.yml   lint, types, tests, e2e, installers on windows-latest
```

## (c) Phase 0 task list

| # | Task | Status | Where |
|---|---|---|---|
| 1 | Bun-workspaces monorepo, strict TypeScript, Biome, EditorConfig, line-ending rules, Husky pre-commit | Done | root config files |
| 2 | Shared contracts: event types (spec Section 9 + system events), JSON-RPC 2.0 envelopes, typed API map, ids | Done | `packages/shared` |
| 3 | App data paths: `%LOCALAPPDATA%\Depo`, override, long-path (`\\?\`) helper, non-ASCII and spaces tested | Done | `engine/src/paths.ts` |
| 4 | Structured JSON logging with rotation and secret redaction | Done | `engine/src/logger.ts`, `redact.ts` |
| 5 | SQLite (WAL) + Drizzle, versioned embedded migrations, backup before migrating, rollback on failure | Done | `engine/src/db` |
| 6 | Event bus: validate, redact, sequence, persist (audit log), broadcast; heartbeat as ephemeral event | Done | `engine/src/events/bus.ts` |
| 7 | WebSocket JSON-RPC server on 127.0.0.1, random port, per-launch token, origin allowlist | Done | `engine/src/api` |
| 8 | Engine entry: ready handshake on stdout, exits with its parent, signal handling | Done | `engine/src/main.ts` |
| 9 | Sidecar build as a single executable for Windows (and dev platforms) | Done | `scripts/build-engine.ts` |
| 10 | Tauri shell: spawn sidecar with token, parse handshake, `engine_connection` command, restart with backoff, kill on exit, tray, single instance, CSP | Done | `apps/desktop/src-tauri` |
| 11 | React UI skeleton with the full layout: sidebar, center tabs, right panel (activity + agent board), bottom panel, status bar, resizable panels | Done | `apps/desktop/src` |
| 12 | Dark (default) and light themes with tokens, Inter + JetBrains Mono self-hosted, WCAG AA contrast | Done | `styles.css` |
| 13 | Live activity feed (virtualized, filter, details) and live heartbeat (status bar, feed, engine panel) | Done | `components/panels` |
| 14 | Tests: engine (Bun), UI (Vitest), e2e + axe accessibility (Playwright), Rust (cargo test) | Done | `*/test`, `e2e/` |
| 15 | MSI + NSIS installer config with WebView2 bootstrapper; CI on `windows-latest` | Done (config); the installer itself must be built on Windows | `tauri.conf.json`, `ci.yml` |
| 16 | Docs: PROGRESS, ARCHITECTURE, DECISIONS | Done | `docs/` |
