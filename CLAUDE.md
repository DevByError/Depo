# Depo: project memory for Claude

Read this first every session. Update the "Status log" and "Next" sections at the end of every work session (what was done, what is next, open problems).

## What Depo is
A fully local, multi-agent AI coding studio for Windows (Tauri 2 + React UI, Bun engine sidecar, SQLite, local models via Ollama / llama.cpp / LM Studio). The user describes software; 15 specialist agents plan, design, build, test, secure and document it in a private copy of the project; the user reviews a diff and approves before anything touches real files. No cloud models, no accounts, no cost per token.

**The full design is in `Depo-System-Description.docx` (v1.0, 4 Nov 2026) at the repo root. It is the source of truth for scope and behaviour.** Other docs: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADRs), `docs/PROGRESS.md`, `docs/PHASE-0.md`.

## Principles to keep (from the system description)
- Local and free; proposed, never imposed (shadow workspace + Diff Review + checkpoint + undo); visible work (activity feed + audit log); tools decide correctness (tests/lint/types, not model claims); Windows first; best model that fits, step down by adding smaller steps and more checking.
- Agents exchange typed JSON messages through the Manager and share a per-project blackboard (brief.md, options.md, plan.json, design-system.json, schema/, openapi.yaml, diagrams/, reviews/, decisions.md). Two-key rule: a different agent reviews every output. Fix loops capped (default 5).
- Small-model reliability matters: read-before-edit, exact search/replace edits, text tool-call recovery, tests as ground truth.

## Agents (15)
Leadership: Manager, Thinking, Reasoning, Project Management. Design: UI/UX Design, Diagram. Builders: Backend, Frontend, Database, Integration, AI Integration. Quality: Testing, Security, Enhancement. Delivery: DevOps and Documentation.

## Repo layout
- `apps/desktop`: Tauri shell (src-tauri) + React UI (src) + Playwright e2e
- `packages/engine`: Bun sidecar (API, event bus, SQLite, tools, agent, workspace, memory, code index, scheduler)
- `packages/model-gateway`: model runtimes, catalog (32 models), Auto-Fit planner, hardware profiler
- `packages/shared`: Zod contracts shared by engine and UI
- `scripts/`: dev, build-engine, setup/build ps1, fake-ollama (scripted model for tests), fixtures (fastapi-demo), verify-catalog
- Commands: `bun run check` (lint+typecheck+tests), `bun run dev`, `bun run tauri:dev`, `bun run test:e2e` (in apps/desktop)

## Phase plan (10 phases; each must pass its acceptance test before the next starts)
| # | Scope | Status |
|---|---|---|
| 0 | Foundations (shell, engine, API, SQLite, events, installers) | Done |
| 1 | Single agent core (gateway, Auto-Fit, tools, workspace, Diff Review, undo) | Done, accepted on Windows with qwen3-coder:30b |
| 2 | Projects, memory, code index, scheduler, concurrent projects | Done, concurrency confirmed on Windows |
| 3 | **Agent team**: manifests, all 15 agents, Manager + task graph, blackboard, message protocol, two-key reviews, loop limits, Plan Board, Agent Board. Accept: todo app (Next.js + FastAPI + PostgreSQL + login) built and tested through the full pipeline | **NEXT, not started** |
| 4 | Design systems, diagrams, screenshots + vision review, business brief, UX audit, slide decks | Planned |
| 5 | Skills installer/vetting, MCP client, knowledge packs (+ offline OSV) | Planned |
| 6 | Security + testing depth (Semgrep, gitleaks, OSV, Trivy, Bandit, ZAP, k6, Lighthouse) | Planned |
| 7 | Agent Lab (versions, evals, A/B, promote/rollback) | Planned |
| 8 | Building blocks library + all work modes | Planned |
| 9 | Polish and release (onboarding, palette, notifications, auto-update, signed installers) | Planned |

## Status log (newest first; add an entry every session)
- 2026-11-06: Read `Depo-System-Description.docx` fully; created this CLAUDE.md. No code changes. Repo state: branch `main`; `bun.lock` modified; untracked `scripts/fixtures/fastapi-demo/fastapi-demo2/` (probably a leftover from a test run; check before committing) and the .docx.
- Before that (from git log): small-model hardening (read-before-edit, tolerant text tool calls, unclosed-call repair, stripping copied line numbers, retry unreadable calls); tests checked before accepting a finished task; Stop works on tasks left "working" by an old engine.

## Next
1. Decide how to slice Phase 3 (suggested: engine-side agent manifest format + typed message protocol + blackboard first; then Manager + plan.json with 2-3 agents; then add agents and the Plan/Agent Boards; full todo-app pipeline last).
2. Fix doc drift: README still says "Phase 0 of 10"; PROGRESS.md says Phase 2 Windows checks pending while the system description says confirmed.
3. Run `bun scripts/verify-catalog.ts` on a PC with internet (catalog tags unverified).

## Known issues
- Slow on modest hardware (GTX 1650 4 GB: ~2 tok/s writing with qwen3-coder:30b); Auto-Fit should model prompt-reading speed and prefer smaller models.
- Qwen3-Coder sometimes emits malformed tool calls Ollama rejects; the agent retries.
- Catalog tags unverified; installers unsigned; engine exe ~115 MB; DB file may stay locked briefly after close on Windows (EBUSY in tests).

## Working rules for Claude on this repo
- Check against the system description before designing anything new; do not invent agent roles or flows that contradict it.
- Run `bun run check` before saying something is done; report failures honestly.
- Commit only when the user asks. Keep this file current.
