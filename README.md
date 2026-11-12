# Depo

A fully local, multi-agent AI coding studio for Windows. Describe the software you want; a team of local AI agents plans, designs, builds, tests, secures and documents it, and **you approve every change before it touches your real files**. No cloud models, no accounts, no cost per token. Depo itself has no login; it builds systems that can have one.

![Depo, early build](docs/screenshots/phase0-dark.png)

## What it does

- **Private copy, you decide.** Agents work in a shadow copy of your project. You review a diff (with line comments, "Request changes", checkpoints and undo) and approve before anything is applied.
- **15 specialist agents** (Manager, Backend, Frontend, Database, Tester, Security, UX/Design, ...) that plan together, review each other's work, and fix problems until the tests pass (or tell you exactly why they could not).
- **A step plan you can see.** A request is split into steps (tables, routes, pages, tests), shown first, and each step is checked by tools (type checks, tests, a page check), not by what the model claims.
- **`DEPO.md` per project**, like `CLAUDE.md` for Claude Code: what the project is, commands, rules, a status log, what is next and what is still wrong. Agents read it first in every task; Depo updates it when a task ends and it shows up in the diff.
- **Agent Lab.** Every agent has versions (1.0 ships; 1.1 to 1.3 are newer prompts). Compare two versions on the same checks, promote the better one, roll back.
- **Fast on a modest PC.** Forgiving edits, a light history, retrieval over your project (`find_code`, related code in each step), tables written without a model call, pages built side by side when the runtime allows it. Numbers and ideas: [docs/SPEED-AND-ACCURACY.md](docs/SPEED-AND-ACCURACY.md), [docs/RAG.md](docs/RAG.md).
- **Showcase screen** in the app: real numbers from your PC (tasks, tool calls, errors, agent versions) and the feature list, for showing Depo to someone.
- **Local security and testing tools** when installed (Semgrep, gitleaks, OSV, Trivy, Bandit, ZAP, k6, Lighthouse), skills, MCP servers and offline knowledge packs. Anything downloaded is untrusted until scanned and enabled by you.

## Quick start (Windows)

### 1. Install the tools (once)

| Tool | Why | How |
|---|---|---|
| **Bun 1.4+** | runs the engine and the scripts | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Ollama** | runs the local models | <https://ollama.com/download> |
| Rust (MSVC) | only for the desktop window | <https://rustup.rs>, host `x86_64-pc-windows-msvc` |
| Visual Studio 2022 Build Tools | only for the desktop window | workload "Desktop development with C++" |
| WebView2 | only for the desktop window | already on Windows 11 |
| Git | project history | <https://git-scm.com/download/win> |

Then, from the repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1   # checks the tools and runs bun install
```

### 2. Get a model

Depo uses whatever Ollama has. Pick by your graphics card (VRAM):

| Your GPU | Start with | Notes |
|---|---|---|
| 4 GB (e.g. GTX 1650) | `ollama pull qwen2.5-coder:3b` | fast (15 to 26 tokens/s); the 7b runs at about 1.6 tokens/s here, too slow to use except for a stuck step |
| 6 to 8 GB | `ollama pull qwen2.5-coder:7b` | good balance |
| 12 GB or more | `ollama pull qwen2.5-coder:14b` (or a larger Qwen3-Coder) | best results |

Optional: `ollama pull nomic-embed-text` (semantic search), a vision model such as `qwen2.5vl:3b` (to compare a page with a design picture).

### 3. Run it

```powershell
bun run dev          # the UI in your browser at http://127.0.0.1:1420, with a live engine
bun run tauri:dev    # or the desktop window (builds the engine first)
```

### 4. Your first task

1. Open or create a project folder (the welcome tour shows how). A blueprint (full stack, Next + Bun + MySQL, FastAPI, React) gives a good start for a new system.
2. In **Models**, check that Ollama is found and the coder role has your model.
3. In the chat, describe what you want. Depo asks once: *"Let Depo work without asking?"* Choose **Yes, allow everything in this task** to let agents install packages, run tests and start servers without more questions (blocked commands stay blocked; changes still wait for you).
4. Watch the plan and the activity feed. When it says **Changes ready for review**, open **Diff Review**, read the diff, and apply or send comments back.
5. Open the **Showcase** screen for the numbers and the agent versions. Install the newer agent versions there, compare them in **Agent Lab**, and promote the one that scores better.

Tips for a small GPU: use the single coding agent ("Backend only" style modes) rather than the full team; set `team.reviews` to `key`; keep `scheduler.max_parallel` at 1.

## Settings worth knowing

| Setting | Default | What it does |
|---|---|---|
| `team.reviews` | `all` | which agents are reviewed by another agent (`all`, `key`, `off`) |
| `team.parallel` | 2 | independent team tasks at the same time |
| `scheduler.max_parallel` | 1 | model requests at once; raise to 2 only on a GPU that can serve two (Depo then starts Ollama with `OLLAMA_NUM_PARALLEL`) |
| `agent.parallel_steps` | 2 | pages built side by side, within what the scheduler allows |
| `agent.generate_tables` | on | Depo writes simple table steps itself (MySQL/MariaDB schemas) |
| `depomd.auto` | on | create and update `DEPO.md` at the end of a task |
| `agent.step_up` | on | a stuck step goes to a larger installed model |
| `memory.auto` | on | Depo remembers facts about the project after a task |

Project settings (full access, tasks at once) are in the project's Overview.

## Check that it really works

```powershell
bun run check                          # lint + type-check + all unit tests
cd packages\engine; bun test           # the engine tests alone (recommended on a slower PC)
bun scripts/real-run.ts tasks          # REAL smoke test: real engine, your Ollama, a real tiny project
bun scripts/real-run.ts lab            # compares agent versions 1.0 and 1.3 with your real model
```

`bun run check` runs the UI and engine suites at the same time; on a slow PC that load can make local-network tests fail, so run the engine tests alone for a true result. The real run needs Ollama running with a coder model (it uses `qwen2.5-coder:3b`; pass another name as the last argument). Browser end-to-end tests: `cd apps\desktop; bunx playwright install chromium; bun run test:e2e`.

## Build the installers

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

Output: `apps\desktop\src-tauri\target\release\bundle\msi\` and `...\nsis\`. The installers are not code-signed yet, so Windows SmartScreen shows "Windows protected your PC": choose **More info, Run anyway**. Release steps: [docs/RELEASE.md](docs/RELEASE.md).

## Troubleshooting

- **"Ollama not found" or no models:** start Ollama (`ollama serve`, or open the Ollama app) and run `ollama list`. Depo starts `ollama serve` itself when it is installed and not running.
- **A task is very slow:** read the model's speed in **Models**. Under about 3 tokens a second a long task takes hours; use a smaller model. The engine log warns once per slow model.
- **The window shows "Engine busy" or disconnects:** see `%LOCALAPPDATA%\Depo\logs\engine.log` for "the engine was blocked" or "ui client disconnected".
- **Where is my data:** `%LOCALAPPDATA%\Depo\` (database, logs, models, skills, workspaces). Set `DEPO_DATA_DIR` to use another folder. Logs are JSON lines with secrets removed.
- **Tests fail on Windows only:** please open an issue with the test name; known flaky ones are network tests under heavy load.

## Repository

```
apps/desktop        Tauri 2 shell (src-tauri) + React UI (src) + Playwright e2e
packages/engine     Bun sidecar: agents, team runner, tools, retrieval, scheduler, SQLite, API server
packages/model-gateway   Ollama / llama.cpp / LM Studio runtimes, model catalog, Auto-Fit
packages/shared     Zod contracts shared by the engine and the UI
docs/               ARCHITECTURE, DECISIONS (ADR-0001 to 0100), PROGRESS, RELEASE, RAG, SPEED-AND-ACCURACY
scripts/            dev, engine build, Windows setup and build, real-run smoke test, fake Ollama for tests
```

The full design lives in a separate document (`Depo-System-Description.docx`, not part of this repository); [CLAUDE.md](CLAUDE.md) is the working memory (status log, next steps, known issues) that every session starts from.

## Status

Phases 0 to 9 are built. Tests use scripted models; real-model runs so far are small (a 3b model on a 4 GB GPU adds a function and edits files correctly, and still sometimes skips a part of a request such as the test file; that is the next thing being fixed). Signing and the in-app update install are untested. See [CLAUDE.md](CLAUDE.md) and [docs/PROGRESS.md](docs/PROGRESS.md).
