# Architecture decisions

Short ADRs: decision, reason, alternatives. Newest last.

## ADR-0001: Bun workspaces monorepo with Biome
- **Decision:** One repo with Bun workspaces (`apps/*`, `packages/*`), Biome for lint and format, Husky pre-commit.
- **Reason:** The engine already runs on Bun; one tool for install, scripts and tests keeps setup on Windows short. Biome is a single fast binary with no plugin tree.
- **Alternatives:** pnpm + ESLint + Prettier (slower, more config); Nx/Turborepo (not needed at this size).

## ADR-0002: TypeScript 5.9, not 7.0
- **Decision:** Pin TypeScript 5.9.3 for type-checking.
- **Reason:** TypeScript 7 (native compiler) is new; editor tooling and some library typings still target 5.x. Strict mode is identical for our purposes. Revisit in Phase 9.
- **Alternatives:** TypeScript 7.0 now.

## ADR-0003: JSON-RPC 2.0 over a loopback WebSocket, token in the query string
- **Decision:** The UI talks to the engine over `ws://127.0.0.1:<random port>/rpc?token=<per-launch token>`. The engine checks the token with a constant-time compare and only allows Tauri and localhost origins.
- **Reason:** Browsers cannot set headers on WebSocket handshakes; the query string is the standard workaround. The token never reaches logs (URLs are not logged). A WebSocket gives us server push for the live feed. JSON-RPC is simple and CLI-friendly.
- **Alternatives:** Tauri IPC only (would tie the engine to the UI and block the future CLI); HTTP + SSE (two channels); `Sec-WebSocket-Protocol` token (works, but less obvious and still visible to the page).

## ADR-0004: Ready handshake on stdout, logs elsewhere
- **Decision:** The engine prints exactly one `DEPO_ENGINE_READY {json}` line on stdout. Logs go to rotating files (and stderr in dev).
- **Reason:** The port is random, so the shell must learn it; a single parseable line is robust across shells and encodings.
- **Alternatives:** Fixed port (collisions, multiple instances); a port file on disk (stale files after crashes).

## ADR-0005: Embedded migrations with our own runner; Drizzle for queries
- **Decision:** Migrations are SQL strings in `engine/src/db/migrations.ts`, applied in order, each in a transaction, recorded in `schema_migrations`. A `VACUUM INTO` backup is taken before upgrading an existing database. Drizzle ORM is used for typed queries.
- **Reason:** The engine ships as a single compiled executable with no files beside it; drizzle-kit's migrator reads migration folders from disk. The runner is about 50 lines and fully tested (idempotent, backup, rollback on failure).
- **Alternatives:** drizzle-kit migrations shipped as resources (extra packaging on Windows); raw SQL without an ORM (loses typed queries).

## ADR-0006: System event types and ephemeral events
- **Decision:** Add `heartbeat`, `engine_started`, `engine_stopping`, `client_connected`, `client_disconnected`, `settings_changed`, `info`, `warning` to the spec's event list. Events can be `ephemeral` (broadcast, not stored); heartbeats are ephemeral.
- **Reason:** Phase 0 must show live engine activity before any agent exists. Storing a heartbeat every 2 seconds would bloat the audit log with no value.
- **Alternatives:** A separate heartbeat channel (more protocol surface).

## ADR-0007: Sidecar supervision
- **Decision:** The engine exits when stdin closes, when its parent PID disappears, or on signals; Tauri kills it on exit and restarts it after a crash, at most 5 times per minute, then reports the problem.
- **Reason:** On Windows, killing a parent does not kill its children; three independent exit paths prevent orphaned engines. The restart budget stops crash loops.
- **Alternatives:** Windows Job Object around the sidecar (planned for agent-run commands in Phase 1; may also be applied to the sidecar then).

## ADR-0008: Custom panel splitter instead of react-resizable-panels
- **Decision:** A small `Splitter` component (pointer drag + arrow keys, ARIA separator) with sizes in the UI store.
- **Reason:** react-resizable-panels 4.x changed its API substantially; our layout needs only fixed-size side panels around a flexible center. About 80 lines, keyboard accessible, no dependency.
- **Alternatives:** react-resizable-panels; allotment.

## ADR-0009: Heavy UI libraries arrive with their features
- **Decision:** Monaco, xterm.js, Mermaid and React Flow are not installed in Phase 0. They are added in the phase whose feature uses them (Phase 1: Monaco, xterm; Phase 4: Mermaid, React Flow), lazily loaded.
- **Reason:** Keeps cold start and bundle small (spec: cold start < 3 s), and avoids shipping unused code.
- **Alternatives:** Install everything now.

## ADR-0010: App data location
- **Decision:** `%LOCALAPPDATA%\Depo` on Windows (fallback `%USERPROFILE%\AppData\Local\Depo`), overridable with `DEPO_DATA_DIR`. On Linux/macOS (development only for now) `$XDG_DATA_HOME/depo`.
- **Reason:** Per-user, not roamed (databases and models are large), as the spec requires.

## ADR-0011: Installers
- **Decision:** Build both MSI (WiX) and NSIS. NSIS installs per user (no admin prompt). WebView2 uses the embedded bootstrapper (silent). Code signing is off until a certificate is available.
- **Reason:** Spec requires MSI + NSIS. Per-user install fits a personal tool. Unsigned builds trigger SmartScreen ("Windows protected your PC" → More info → Run anyway); this is documented in the README.

## ADR-0012: Closing the window quits Depo
- **Decision:** In Phase 0 the close button quits the app (and the engine). The tray icon offers Show and Quit.
- **Reason:** Hiding to the tray while nothing runs in the background would surprise users. Phase 9 revisits this with background overnight mode, where keeping the engine running matters.

## ADR-0013: Accessibility checks are part of the test suite
- **Decision:** Playwright e2e runs axe-core (WCAG 2.2 AA tags) on both themes and fails on serious or critical violations. Scrollable regions are focusable (`tabIndex=0` + label), so Biome's `noNoninteractiveTabindex` is turned off in favour of the WCAG rule.
- **Reason:** The spec sets WCAG AA for Depo itself; automated checks keep it true as the UI grows.

## ADR-0014: Brand mark "Bracket D" in Graphite
- **Decision:** The Depo mark is the letter D drawn as a crate (two plank lines) between code brackets, `<D>`, on a graphite tile (#1b1f27, brackets #8a93a6, D white). Source: `apps/desktop/src-tauri/installer/depo-mark.svg`; app icons are generated from `app-icon.png` with `tauri icon`.
- **Reason:** Chosen by the owner from two rounds of concepts. It keeps the name visible, links "depot" (crate) with code (brackets), and stays readable at 16 px.
- **Installer branding:** NSIS uses the icon plus a header (150×57) and sidebar (164×314) image; MSI uses a banner (493×58) and dialog image (493×312). All are 24-bit BMPs in `src-tauri/installer/`. The standard NSIS folder page stays for now; removing it needs a custom installer template (Phase 9).

## ADR-0015: Ollama through its native API; llama.cpp and LM Studio through the OpenAI-compatible API
- **Decision:** `@depo/model-gateway` has two adapters behind one `ModelProvider` interface. Ollama uses `/api/chat`, `/api/tags`, `/api/pull`, `/api/delete`, `/api/embed`. llama.cpp server and LM Studio use `/v1/chat/completions` (SSE), `/v1/models`, `/v1/embeddings`.
- **Reason:** The spec says "through their OpenAI-compatible endpoints", but Ollama's compatible endpoint cannot set the context window (`num_ctx`), download or delete models, or report generation time. Those are needed for Auto-Fit, the model manager and benchmarks. The neutral interface keeps the rest of Depo unaware of the difference.
- **Safety:** providers may only point at loopback or private-network addresses (`isLocalUrl`). There is no cloud adapter.

## ADR-0016: Auto-Fit planner is a bandwidth model, calibrated by a real benchmark
- **Decision:** Memory need = weights (params × bits per weight, or exact size) + KV cache (bytes per token × context) + vision projector + 0.6 GB. Speed ≈ 0.6 × 1 / (active bytes on GPU ÷ GPU bandwidth + active bytes in RAM ÷ RAM bandwidth). GPU bandwidth is guessed from VRAM size until the user runs a benchmark, which then scales every estimate (clamped 0.25×–4×).
- **Choice rule:** strongest model first; full GPU at the best precision, else GPU + RAM split or CPU at the best precision that is comfortably fast (else the fastest usable one); a minimum speed per role and mode rejects unusable plans. A model within 2 score points that is 3× faster wins the tie.
- **Reason:** Simple, explainable, and testable against the spec's reference profiles (tests in `model-gateway/test/autofit.test.ts`).
- **Catalog caveat:** the build container cannot reach ollama.com, so the shipped catalog (`packages/model-gateway/catalog/models-catalog.json`) was written from knowledge of the Ollama library. `bun scripts/verify-catalog.ts` checks every tag against the Ollama registry and must be run on a machine with internet before a release.

## ADR-0017: Shadow workspace is a filtered copy with linked dependency folders
- **Decision:** Each task gets a copy of the project in `workspaces/<task>/` that leaves out `.git`, build output and caches. `node_modules`, `.venv`, `venv` and `env` are linked (junctions on Windows, symlinks elsewhere) instead of copied, so tests run without reinstalling. A `manifest.json` records the sha1 of every copied file; the diff is the shadow compared with that baseline, and a project file whose hash moved since the baseline is a conflict that blocks apply for that file.
- **Reason:** A git worktree needs a clean git repo and misses untracked files; a filtered copy works for any folder. Linking dependencies keeps a copy fast on large projects. Agents can still change dependency folders through the link, so installs are gated by the command policy (ADR-0018).
- **Apply and undo:** applying saves a checkpoint (copies of the files about to change) first, then applies the selected files or hunks (jsdiff). Undo restores the checkpoint and refuses, unless forced, if the user edited those files since.

## ADR-0018: Command policy with deny, ask and allow, and approvals in the chat
- **Decision:** Every `run_command` is split into its parts (`&&`, `||`, `;`, `|`, `&`, with `2>&1` kept as a redirect) and each part is classified. Deny: destructive or system-wide commands (format, disk tools, registry edits, `rm -rf /`, encoded PowerShell, shutdown, credential tools). Ask: installs, network fetches, git push/reset, deletes outside the workspace. Allow: tests, builds, linters and read-only commands. The strictest part wins. "Ask" pauses the agent and shows an approval card in Chat; a declined command returns an error the model can react to.
- **Reason:** The spec requires a command policy and Job Objects; asking per command keeps the user in control without stopping on every test run.
- **Containment:** on Windows each command runs in a Job Object (kill on close, memory limit), so stopping a task kills the whole process tree. Elsewhere a process group is used.

## ADR-0019: Files viewer and Diff Review without Monaco for now
- **Decision:** Phase 1 ships a read-only file viewer with line numbers and a hand-built unified diff view with per-file and per-hunk checkboxes. Monaco arrives when in-app editing does.
- **Reason:** Monaco adds about 3 MB and a worker setup, while review only needs a readable diff and selection. Keeping it out keeps the UI bundle and startup small (ADR-0009).

## ADR-0020: Phase 1 coding agent runs a plain tool loop, with text tool-call fallback
- **Decision:** One agent (`coder@1.0.0`) loops: model call with tool definitions → run the tool calls → repeat, up to 40 steps, until the model answers without tools. Models that print tool calls as text (`<tool_call>` tags, JSON fences, bare JSON) are parsed too. Transient model errors are retried twice. Old tool outputs are shortened when the history approaches the context window. Follow-up messages continue the same task and the same shadow copy.
- **Reason:** Small local models vary a lot in how well they follow native tool calling; the text fallback makes 7B-class models usable. The multi-agent Manager arrives in Phase 3 on top of this loop.
- **Testing:** `scripts/fake-ollama-lib.ts` is a scripted Ollama that performs the acceptance task through real tool calls, so the whole flow (agent, real pytest, diff, apply, undo) is tested without a GPU.
