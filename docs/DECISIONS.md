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

## ADR-0021: Code index uses tree-sitter WebAssembly grammars embedded in the engine
- **Decision:** Symbols (classes, functions, methods, types) come from `web-tree-sitter` 0.25.10 with the prebuilt grammars of `tree-sitter-wasms` 0.1.13 for Python, TypeScript, TSX, JavaScript, Go, Rust, Java, C#, Kotlin, PHP, Dart, Ruby and C. The `.wasm` files are imported with `with { type: "file" }`, so `bun build --compile` embeds them and the engine works offline. One generic walker maps node types to symbol kinds for every language.
- **Reason:** Native tree-sitter bindings need a C toolchain on Windows and per-language builds; WebAssembly grammars are portable and already compiled. Newer web-tree-sitter releases cannot load these grammar files (ABI mismatch), so the two versions are pinned together.
- **Cost:** about 14 MB more in the engine executable.

## ADR-0022: Embeddings are stored as float32 blobs and searched in memory
- **Decision:** Code is split into 60-line chunks (10 lines overlap), embedded with the `embedding` role model through the scheduler at background priority, and stored in the `embeddings` table as normalised float32 blobs. Search loads a project's vectors once and does a brute-force dot product. Without an installed embedding model the index keeps symbols only and says so.
- **Reason:** A project of a few thousand files gives tens of thousands of vectors; a linear scan takes milliseconds and needs no native SQLite extension (sqlite-vec would have to be shipped and loaded per platform). Revisit if projects get much larger.
- **Updates:** a recursive file watcher (1.5 s debounce) re-indexes changed files only, detected by content hash.

## ADR-0023: Project memory is a Markdown file plus structured facts; lessons come from fix loops
- **Decision:** Each project has `projects/<id>/project-memory.md` in the data folder (seeded with name, description and stack) and rows in `memory_facts` (fact, decision, preference, lesson). Global memory is `projects/_global/global-memory.md` plus facts with no project. Before each run the agent's system prompt gets the memory (5,000 characters) and a repo map (3,500 characters). Agents save facts with a `remember` tool. When tests fail and later pass in the same task, Depo stores a lesson keyed by an error signature (the first error line with paths, numbers and quoted values removed); the next failing run with the same signature shows the lesson with the test output.
- **Reason:** Memory stays readable and editable by the user, and is never written into the user's project folder.

## ADR-0024: One model queue for all projects
- **Decision:** Every model call goes through `ModelScheduler`. Order: priority (chat > task > background), then the model that is already loaded (to avoid slow reloads, with a 20 s starvation guard), then round-robin between projects, then first come. Limits: `scheduler.max_parallel` (default 1, set in Settings) across all projects and `maxParallel` per project. Pause all, or pause one project; waiting tasks keep their place and show "Waiting for the model to finish another job". Tests and builds do not go through the queue, so they run in parallel.
- **Reason:** A single consumer GPU serves one request well; running two at once mostly makes both slower and can push a model out of VRAM.

## ADR-0025: Project lifecycle never deletes the user's files
- **Decision:** "Remove from Depo" deletes Depo's rows, task copies, checkpoints, memory and index for the project; the project folder is left alone. Create, clone and duplicate only write into a folder that did not exist (or is empty). Duplicate copies the folder without installed packages and caches, plus memory and settings. Export writes a .zip (project files without packages, plus `.depo-export/project.json` and `project-memory.md`) to Downloads. Removing task copies unlinks the dependency links first, so the real `node_modules` or `.venv` can never be deleted through them.

## ADR-0026: One tool loop for every agent
- **Decision:** The loop that asks the model, runs tools, repairs unreadable calls and checks the tests before accepting "done" lives in `agent/loop.ts`. The single coding agent and all 15 team agents run through it.
- **Reason:** Every robustness fix for small models (text tool calls, copied line numbers, read-before-edit, failing-test nudges) now applies to every agent. The Phase 1 and 2 tests kept passing through the refactor.
- **Alternatives:** A second loop for the team (duplicated fixes, drift).

## ADR-0027: The Manager plans with structured output and a fallback
- **Decision:** The Manager asks for a task graph as JSON validated against a schema. Unknown agents, missing dependencies and cycles are rejected; if the model cannot produce a valid plan, the standard pipeline of the work mode is used. Code-producing plans always get a Testing step.
- **Reason:** Small local models fail at free-form planning. A valid default means the team still runs.
- **Alternatives:** Letting the model free-run with tools (unpredictable on weak PCs).

## ADR-0028: Agents talk through a typed blackboard, owned section by section
- **Decision:** Shared state is a versioned blackboard in SQLite (project scope, history kept). An agent writes only the sections in its manifest (`decisions.md` is append-only for everyone). Messages between agents are typed (handoff, request, review, question, result, blocker) and stored per task. Notes worth keeping are exported to `docs/depo/` in the change set, so the user approves them like any other file.
- **Reason:** Free conversation between small models drifts. Ownership makes mistakes visible and cheap to fix.
- **Alternatives:** Passing whole transcripts between agents (context overflow).

## ADR-0029: Review is a setting, not a constant
- **Decision:** The two-key rule is on by default (`team.reviews = all`). `key` reviews only architecture and API work; `off` skips agent reviews. A reviewer that cannot produce readable JSON approves with confidence 0 and says so. Login and payment work goes to Security.
- **Reason:** On a 4 GB GPU a review pass doubles the model calls. The user decides the trade-off. Tests, not reviews, remain the ground truth.

## ADR-0030: Screenshots and PDFs use the PC's own browser
- **Decision:** `render_screenshot` and deck PDFs call Edge or Chrome in headless mode (`DEPO_BROWSER` overrides, `DEPO_NO_BROWSER=1` disables). Pages must be project files or localhost.
- **Reason:** No Playwright or Chromium download inside the engine, no extra gigabytes, no internet. Verified to produce PNG and PDF.
- **Alternatives:** Bundling Playwright (large, network install).

## ADR-0031: Skills are scanned before they can be enabled, and load on demand
- **Decision:** A skill starts disabled with a stored security report. A report with serious findings (pipe-to-shell, destructive commands, credential access, prompt-injection phrases, binaries, symlinks) needs an explicit override. Updates that scan worse than the approved version are disabled again. Only name and description enter the prompt; `use_skill` loads the instructions.
- **Reason:** Skills are text that steer an agent and sometimes scripts; they are untrusted input. Progressive loading saves context on local models.

## ADR-0032: MCP servers are local, scanned, and asked about
- **Decision:** stdio programs and local HTTP addresses only. "Test" connects, lists tools and scans names and descriptions for hidden instructions. Tools that are not read-only ask the user once per task unless the server is trusted. Server environment values never leave the engine.
- **Reason:** MCP tool descriptions are a known prompt-injection route; running a server is running code.

## ADR-0033: Knowledge packs use full-text search, not embeddings
- **Decision:** SQLite FTS5 with BM25 and Porter stemming over heading-aware passages. Results always name the pack and version.
- **Reason:** Works offline with no model installed and no GPU time; embeddings can be added later for the code index only.
- **Note:** The pack catalog lists public GitHub folders; addresses are unverified until installed.

## ADR-0034: Security checks work without any installed scanner
- **Decision:** Depo ships its own secret and insecure-code rules and the offline OSV check, and adds Semgrep, Gitleaks, OSV-Scanner, Trivy and Bandit when they are already on PATH. It never downloads or installs a scanner; it says how. The score is 100 minus capped penalties per severity; any high or critical finding, or a score under 60, blocks the release. ZAP, k6 and Lighthouse are detected and only local addresses (strict character allow-list, because the URL reaches a command line) can be tested.
- **Reason:** A seeded vulnerable project must be found on a fresh PC. Fewer false alarms matter more than catching everything; external tools add depth.

## ADR-0035: Agent Lab versions override manifests at run time, behind a test gate
- **Decision:** Built-in manifests never change. A saved version is inactive until promoted. Promotion needs a test run and refuses a version that scores lower than the one in use on the same checks (a person can force it). Rollback is another promotion row, so history is kept. Ownership of blackboard sections cannot be edited. Imported agents are scanned and never start active.
- **Reason:** Prompt edits regress silently; a score gate and a one-click way back make experimenting safe.

## ADR-0036: Building blocks are self-contained and ship their own tests
- **Decision:** Ten blocks (login, roles, audit log, rate limit, config, pagination, login form, Postgres compose, Python login and roles) use only the standard library or Node built-ins. `use_block` never overwrites a different file. The tests of every block run in Depo's own test suite.
- **Reason:** Security-sensitive code should be written once and tested, not regenerated by a small model each time. Depo itself has no login; blocks are for the systems it builds.

## ADR-0037: Updates are checked on request and never installed by Depo
- **Decision:** "Check for updates" asks the GitHub releases API for the configured repository and shows a link. No background checks, no silent install. The release workflow pins its actions to commits and publishes from a job that never sees the signing secrets.
- **Reason:** Local-first means no surprise network traffic; in-app installs need signing keys and a real release to test.

## ADR-0038: Previews run on loopback, from the real folder or a task's private copy
- **Decision:** Depo starts a project's dev server itself (detected recipe or a saved command), on a free port on 127.0.0.1, through the command policy and contained like any command. A preview of a task's private copy lets the owner and the agents run new code before it overwrites the real files. `http_check` only reaches loopback addresses.
- **Reason:** "Give me a link and I can see the result" without exposing anything to the network, and end-to-end proof that the built system runs, not only unit tests.

## ADR-0039: Agent knowledge is a small core plus topics loaded on demand
- **Decision:** Every agent's prompt carries a short playbook core and a topic list; one or two topic sections are added when the request or detected stack matches and the model's context allows it; the rest is read with `read_playbook`.
- **Reason:** Local models have small contexts and slow prompt reading. Progressive loading gives them depth without paying for it on every step.

## ADR-0040: Depo remembers by itself, conservatively
- **Decision:** After a finished task, facts read from the files are saved without a model call, plus at most five items from a background summary. Items are deduplicated, capped (40 per project), filtered for secrets and marked "auto"; the owner can delete them or turn `memory.auto` off. Preferences are saved only when the owner gives a reason.
- **Reason:** Memory that grows without care becomes noise or leaks secrets; small, checked items stay useful.

## ADR-0041: Decisions are events
- **Decision:** What agents decide (plans, reviews, send-backs, results, ADRs, the release verdict) is emitted as a `decision` event with plain text and structured details, and `team.timeline` builds the Team view from the plan and the events table.
- **Reason:** The owner wants to watch the team think. Events are already stored, streamed and replayable, so decisions need no new storage.

## ADR-0042: Look and layout
- **Decision:** Slate surfaces with one teal accent, IBM Plex Sans, agent family colours as theme tokens, every text colour checked for AA contrast on every surface. Work screens stay in the top tab strip; tool screens move to an icon rail; side panels become drawers below 1180 px (right) and 860 px (left).
- **Reason:** Twenty tabs in one strip did not fit; a calm, consistent look reads as a professional tool.

## ADR-0043: Steering notes are read at step boundaries
- **Decision:** A note sent while an agent works waits in the task's inbox and is read at the top of the agent loop or before a final answer, never in the middle of a model call or a command. In a team the Manager reads it first and may replan. Unread notes become a follow-up when the run ends normally.
- **Reason:** Interrupting a local model mid-call wastes minutes of prompt reading; a step boundary is the earliest point the note can change what happens next without breaking a tool call.

## ADR-0044: Line comments belong to a change set and carry over by exact quote
- **Decision:** Review comments are stored per change set and line range with the quoted code. "Request changes" sends them as one follow-up; on the next version a comment carries over only when its quoted code still matches exactly, otherwise it is marked outdated.
- **Reason:** Fuzzy re-anchoring would put feedback on the wrong line; an honest "outdated" is better than a confident mistake.

## ADR-0045: Time estimates are learned on this PC and say when they are guesses
- **Decision:** Estimates come from this PC's own finished steps per agent and kind, scaled by today's model speed, with a first guess from model speed when there is no history, labelled as such.
- **Reason:** Speed on a 4 GB GPU differs by orders of magnitude from published benchmarks; only local history is honest.

## ADR-0046: Git commits only what Depo applied and never pushes
- **Decision:** Committing is an owner click after an apply. Only the applied files are staged (literal pathspecs), every git command goes through the command policy, failures roll back, and Depo never pushes or rewrites history.
- **Reason:** The owner's own uncommitted work must never end up in a Depo commit, and anything that leaves the PC stays the owner's decision.

## ADR-0047: Page checks run in a local headless browser and block the internet
- **Decision:** `check_page` drives the installed Chromium-family browser over the DevTools Protocol with a temporary profile, opens loopback addresses only, blocks every outside request and counts it as a failure with advice to self-host, and validates screenshot paths before serving them. The vision review runs only for agent checks, at background priority.
- **Reason:** Agents must see what they build without anything leaving the PC; an app that needs a CDN to render is not finished for a local-first owner.

## ADR-0048: A finished task's private copy starts by itself under a standing setting
- **Decision:** When changes are ready for review Depo starts the private copy (setting `preview.auto_start`, default on), treating the setting as the owner's OK for the start command. It never runs a denied command, never installs packages, and stops the copy when the changes are applied or discarded unless pinned.
- **Reason:** "Give me a link and I can see the result" should not need extra clicks, but installs and denied commands still need the owner.

## ADR-0049: The code map is generated, kept out of the project, and type-only imports never count
- **Decision:** Imports are read from the code index; the module diagram lives in Depo's data folder and is copied into the project only when the owner asks. TypeScript `import type` edges are kept apart and never make a cycle.
- **Reason:** Generated files in the repo create noise in diffs; type-only cycles are harmless at run time and would make the map cry wolf.

## ADR-0050: One context size per model, and background work never swaps the model
- **Decision:** Every call to a model uses the same context length (the largest any assigned role needs, capped by what fits in VRAM plus RAM) and the owner's keep-alive. The scheduler holds background jobs that would load a different model while chat or task work waits or runs, and for 3 s after, releasing them after 20 s.
- **Reason:** On a 4 GB GPU a reload costs tens of seconds; Ollama reloads whenever `num_ctx` changes. Prefix reuse only works when the model and its context stay put.

## ADR-0051: highlight.js in a worker, not Shiki
- **Decision:** Code is coloured with highlight.js 11 in a module Web Worker, the core and each grammar loaded on first use, with a size limit above which code is shown plain.
- **Reason:** Measured with `vite build`: the highlight.js core is 21 kB and grammars 0.5 to 13 kB, against 165 kB for Shiki's core and 70 to 230 kB per grammar. Lezer has no PowerShell or batch parser. Colours must never block typing or scrolling.

## ADR-0052: Blueprints start only empty projects
- **Decision:** A plan's first build step starts from a blueprint only when the project has no code and the request does not name a stack the blueprint lacks. Building blocks remain the way to add a piece to existing code.
- **Reason:** Small local models write much better code inside a strong, tested structure, but overwriting or reshaping an owner's existing project would be a betrayal of the review step.

## ADR-0053: The readiness report makes no model calls and its scans never replace the project's score
- **Decision:** Readiness is computed from stored facts only (events, scores, page checks, plan, comments, the change set). A security scan run from the card scans the task's copy and is kept apart from the project's own security report.
- **Reason:** The verdict must be instant, repeatable and honest; a scan of unreviewed changes must not overwrite the score of the code the owner actually has.

## ADR-0054: In the Terminal, "ask" counts as approval but deny always wins
- **Decision:** A command the owner types is judged by the same command policy as agent commands. A deny rule refuses it; a command that would ask for approval runs, because typing it is the approval. It runs contained, with a time limit, no keyboard input and telemetry switched off.
- **Reason:** Asking the owner to approve their own command is noise, but a deny rule is a standing decision that protects them even from a slip.

## ADR-0055: Checkers are the project's own installed tools, never installed by Depo
- **Decision:** Problems come from compilers and linters already on the PC (tsc, Biome, ESLint, ruff, compileall, mypy, pyright, go vet, cargo check), planned from the project's files, run through the command policy with caches kept out of the project.
- **Reason:** Installing tools changes the owner's machine and needs the internet; real findings from the project's own setup are what its CI would say.

## ADR-0056: A pasted link is the only reason Depo goes online, and only to public addresses
- **Decision:** A design reference link is opened in the headless browser only after the owner sends it, with every request (page, styles, fonts, images) checked against a gate that resolves the host and allows public addresses only; downloads are denied and the page gets 25 s. Pictures are read by drawing them on a browser canvas and measuring pixels, so colours are exact without any model; the only model call is the optional vision role, which runs locally like every other role.
- **Reason:** "Make it look like this site" needs the site, and the owner asked for it by pasting the link, but a page must not be able to reach the owner's router, NAS or other machines on the local network through Depo. A DNS answer that changes between the check and the browser's own lookup (rebinding) is a remaining risk; the gate checks every request again, which narrows it to a single short window.

## ADR-0057: A reply that repeats itself is stopped, not waited out
- **Decision:** Each agent step has a reply limit (8192 tokens) and a repetition guard on the stream. A looping reply is cut after a few identical copies, its tool calls run once, and the model is told; three such replies in a row fail the task with a reason that suggests a larger model.
- **Reason:** On the owner's PC, qwen2.5-coder:3b wrote the same four edit calls for 55 minutes, because Ollama generates without limit and nothing watched the stream. Stopping early costs nothing when the model is fine, and turns an hour of nothing into a few seconds and a clear next step.


## ADR-0058: Approvals can cover a task or a whole project, but applying changes always asks
- **Decision:** Approval cards offer "Allow once", "Allow for this task" and "Allow all in this project". The last sets the project's `fullAccess`, which approves commands, installs and downloads inside the private copy without asking. Applying changes to the owner's files always asks.
- **Reason:** The owner asked for the way Claude asks: one question, then the work continues. Everything an agent does happens in a private copy, so the only step that touches the real project keeps its question.

## ADR-0059: The starting project and the reference's colours are written by Depo, not by the model
- **Decision:** For an empty project whose request matches a blueprint, Depo writes the blueprint and the picture's theme tokens into the copy before any agent runs, and tells the agent what is already there.
- **Reason:** A 7B model on a 4 GB GPU spends most of its time (and most of its mistakes) on scaffolding. Doing the predictable part deterministically turns an hour of fragile work into a second and leaves the model the part that needs it.

## ADR-0060: Depo runs a test MySQL database itself, bound to 127.0.0.1, and downloads it only after asking
- **Decision:** Each project can have a MariaDB (or an installed MySQL) database run by Depo on 127.0.0.1 with a random password, in Depo's data folder. On Windows without one, Depo downloads the portable MariaDB zip from archive.mariadb.org after a command approval and checks its SHA-256.
- **Reason:** The owner wants to test apps with real data without installing a database. Binding to 127.0.0.1, a generated password and a folder per project keep it private and disposable; the download is the only network use and the owner approves it.

## ADR-0061: "Done" means Depo ran it; problems go back to the model twice at most
- **Decision:** When an agent finishes with changes, Depo installs the packages, starts the database and seeds it, starts the app and opens it in a browser. Problems go back to the model up to two times; after that the owner gets the report with what still fails.
- **Reason:** Small models declare success early and tell the owner to run things. Checking the way the owner would, and feeding the real errors back, is what makes "come back later and find it working" true; the limit keeps a model that cannot fix it from looping.

## ADR-0062: Without Bun installed, Depo's own engine stands in for it
- **Decision:** When `bun` is not on PATH, commands run with `bun` and `bunx` launchers that start the engine exe with `BUN_BE_BUN=1`.
- **Reason:** The engine is a compiled Bun program, so it already contains Bun. Using it avoids a download and a PATH change on the owner's PC while keeping the app's scripts unchanged.

## ADR-0063: A crashed model runtime is waited for, restarted and given a smaller context
- **Decision:** A refused, dropped or crashed model call waits for Ollama's health check (starting `ollama serve` when it is local and not running) and retries; after two crashes the task halves its context. Stray socket errors are logged and no longer end the engine.
- **Reason:** On a 4 GB GPU a long context is the usual cause of Ollama dropping a request (ECONNRESET). A task should survive a runtime restart, and one broken socket should not take the engine and every other task down with exit code 1.

## ADR-0064: A follow-up shows the model the earlier work as a summary and the copy as it is now
- **Decision:** When a new message arrives after earlier turns in the same task, the model gets the system prompt and one user message: a short list of the earlier requests and answers, the files in the private copy now (`copyTree`), the design reference when it still applies, the new request and "build on the files that are there". The repo map in the system prompt is corrected for the copy (`copyRepoMap`): files the copy no longer has are left out, files only the copy has are added with their top-level declarations. The stored transcript is unchanged.
- **Reason:** On the owner's PC the follow-up "make it responsive" started from zero: the model saw the project folder's index ("README.md (2 lines)") instead of the 46 files in its copy, plus a long transcript with a stale repo map and a made-up answer. A small model copies what it sees, so it must see the current state, not the history.

## ADR-0065: A reply is stopped right after its tool call, and a made-up tool result is never an answer
- **Decision:** While a reply streams, Depo looks for a complete text tool call; 400 characters after the first group of adjacent calls the reply is stopped, cut there, and only those calls run, with a note to make one call at a time. A reply that writes its own `<tool_response>` gets two nudges; after that its own words are kept and the made-up results dropped. Text tool calls are read in tiers (tagged, fenced, bare) so a fenced `package.json` no longer hides the calls.
- **Reason:** qwen2.5-coder:3b wrote 8192-token replies for 11 and 14 minutes: one real call, then pretend results and dozens of pretend calls ("Folder created."). None ran, and the first answer was a pretend tool result. Stopping early saves the minutes and keeps the model working on real results.

## ADR-0066: The same look or the same edit on an unchanged copy is answered by Depo, not run again
- **Decision:** Look-only tools (read_file, list_dir, search, repo_map and others) called again with the same arguments and no change in between get the result plus a note the second time, and only the note from the third time. An `edit_file` call identical to one already applied, on a file unchanged since, is skipped with "you already made this exact edit". `write_file` refuses a folder path or placeholder text such as "Folder created.".
- **Reason:** Small models loop on read, edit, read, edit and add the same CSS block twenty times, or "create" folders as files. The check costs nothing and turns the loop into a finished answer.

## ADR-0067: Depo's own steps are agents you can see; the preview shows real device sizes
- **Decision:** The starting project is written as `starter@depo` and the finish line runs as `tester@depo`; the readiness check is the reviewer. A single-agent task's Team tab shows four lanes (Depo starter, Coder with its model, Depo tester, Depo reviewer) with their state and steps. The finish line also runs each part's tests with the project's package manager (`packageManager` in package.json, then lockfiles) and runs once more after a step-limit stop. The Preview renders the page at the real size (phone 390×844, tablet 820×1180, desktop 1440×900) and scales it to fit (or shows it at 100%), and prefers the front end over an API.
- **Reason:** The owner saw "only the coders" and an empty Team tab, a preview of the API's JSON instead of the site, a phone view that was only a narrow column, and "tests were not run" because Depo ran `npm test` in a Bun project.

## ADR-0068: A role whose model cannot do the job falls back instead of failing
- **Decision:** An automatic vision pick must look able to see (catalog or name); a model the owner chose by hand is tried, since names do not always say so. A model that refuses a picture is remembered across runs (`models.blind`) and never gets pictures again; colours and styles are still used, with a hint to assign a vision model. An automatic pick for a non-coder role whose model is not installed falls back to the coder's model; a role assigned by hand is kept.
- **Reason:** On the owner's PC the vision role pointed at qwen2.5-coder:3b (HTTP 400, not multimodal) and the fast role at a model that was never pulled (404), so each call failed before work began.

## ADR-0069: MySQL 8 test databases keep loopback names, and a server left running is stopped
- **Decision:** For MySQL, Depo no longer passes `--skip-name-resolve` (MariaDB keeps it) and gives `--secure-file-priv` a folder of its own. When Depo gives up on a start, or a stop does not finish, it kills the server's whole process tree (`taskkill /T /F` on Windows, TERM then KILL elsewhere) and then any MySQL or MariaDB process whose command line names the project's data folder (`devdb/procs.ts`; never a server found by name alone, so the owner's own MySQL service is left alone). Before a start with a pid file left behind, and once after a start whose log says the files are locked ("must be writable", "Unable to lock", "another mysqld"), it does the same and tries again. The start error shows the log's `[ERROR]` lines, or the sign-in error when the server runs but refuses Depo.
- **Reason:** On the owner's PC (MySQL 8.0.44) the server started, but `--initialize-insecure` makes only root@localhost, and with names skipped Depo's TCP login from 127.0.0.1 was refused (error 1130). After 90 s Depo killed the process it started, which on Windows is MySQL's monitor: the real server kept running on the data folder, so every later start failed with "ibdata1 must be writable". Checked against a real MySQL 8.0.46: fresh start, a server left running with no saved settings, and a second server holding the files.

## ADR-0070: Depo's own failures at the finish line go to the owner, not the model
- **Decision:** `FinishResult` has `blocked`: things Depo itself could not do. A test database that does not start is one: the finish line stops there (no tests, no app start), the model gets no fix round, and the run report says "Depo could not check the app:" with the reason.
- **Reason:** The database error went to the 7b model as a problem to fix. It told the owner to run `icacls`, wrote pretend shell calls and an Express version of `app.ts`. The model cannot fix Depo's database, and an app without its database cannot be checked.

## ADR-0071: A hung Ollama runner is a crash: unload, wait, retry
- **Decision:** An HTTP 500 that says Ollama cannot reach its model process (`dial tcp`, `connectex`, `wsarecv`, `forcibly closed`, `did not properly respond`, `…/tokenize":`, `…/completion": EOF`) counts as a crash, and a connection that timed out counts as dropped. On a crash the loop unloads the model (keep_alive 0) before waiting for the runtime and retrying, so Ollama starts a fresh runner; two falls still halve the context.
- **Reason:** On a 4 GB card running a 7b model, Ollama answered 500 for `/tokenize` and then timed out; neither was recognised, so four quick retries hit the same hung runner and the task failed.

## ADR-0072: Code pasted into a reply is stopped, and only new files are saved from it
- **Decision:** While a reply streams, a coder's reply that passes 3000 characters with a code block of 15 or more lines and no tool call is stopped (at most 3 times a run). Its complete blocks that name a path (in the fence, as a first-line comment, or on the line before) are saved with `write_file` as normal tool calls, but only for files that do not exist yet and only without placeholders ("// ...", "rest of the code"); blocks still open, shell commands and unsafe paths are skipped. A final answer with a code block of 8 or more lines while no file changed is handled the same way, at most twice. The model is told which files were saved, that existing files must be changed with `edit_file`, and to stop pasting code. A bare `<tool_response>` tag before an ordinary sentence is dropped instead of counting as a made-up result.
- **Reason:** Part 1 of the owner's Skill Finder test "finished" with no file changed: one reply wrote code as text for 88 minutes (8192 tokens at 1.6 tokens a second), and the final answer was a pasted `schema.sql` with only the new tables. Saving a pasted block over an existing file would have lost the users table (and in part 2 replaced the Bun `app.ts` with an Express one), so existing files are never overwritten from a paste. qwen2.5-coder:7b starts most replies with `<tool_response>` followed by prose, which used up the made-up-result nudges.

## ADR-0073: Broken and made-up tool calls are counted until a call runs
- **Decision:** Replies whose text tool calls cannot be read, or that call tools Depo does not have, are counted in a row; the count goes back to zero only when a call runs, and the third such reply ends the task with a plain reason. A call to a tool that does not exist ("add_table") is never taken as the final answer: the model is told the names it used are not tools and gets the list of its real tools and how to append to a file. The "could not be read" note includes the JSON error and asks for a short `search` and not to repeat the call. The parser also repairs `\'` inside strings (and keeps other unknown escapes such as `\d` as a literal backslash).
- **Reason:** On the owner's PC qwen2.5-coder:3b sent the same unreadable `edit_file` 15 times in 20 minutes: the counter meant to stop after 3 was reset by every readable reply, so it never passed 1, and with "Most steps per task" at 100 the loop would have run for hours. In part 1 the same model wrote five calls to `list_tables` and `add_table`, nothing ran, and Depo accepted that as "Finished with no file changes". Its other broken call used `\'`, which JSON does not allow.

## ADR-0074: Small models write files as blocks, not JSON
- **Decision:** A reply's file blocks become tool calls (`agent/blocks.ts`): a SEARCH/REPLACE block under a path line (`<<<<<<< SEARCH`, exact lines, `=======`, new lines, `>>>>>>> REPLACE`, the Aider layout Qwen coders know) is an `edit_file` call (blocks for one file in a row are one call); with an empty SEARCH it is `append_file` (or `write_file` for a file that is not there); a fenced block labelled with the path of a file that does not exist is `write_file`. A whole file pasted for a file that exists is still never saved. SEARCH/REPLACE blocks are read in every reply, with the JSON calls (blocks run first); labelled new files are read in every reply of a model taught file blocks, and for other models only where ADR-0072 already saved them. When the calls came from blocks, the history keeps the reply as the model wrote it and one user note with the results, so the model keeps writing blocks (the transcript keeps them as calls for the activity view). Replies that are writing blocks or a new labelled file are not stopped as pasted code. A new tool, `append_file`, adds text after a blank line at the end of a file (keeping its line ends), so a new table goes at the end of `schema.sql` without copying the old ones. Small models are taught the blocks in the system prompt; unfinished blocks get a nudge.
- **Reason:** On the owner's PC, qwen2.5-coder:3b failed part 1 of the Skill Finder test in two minutes: a made-up tool, then two `edit_file` calls with a missing `]`. A 3B model writes code in fences well but breaks JSON that has to carry code (quotes not written as `\"`, brackets). Adding a table to a file meant copying its last lines into an exact `search`, which small models get wrong.

## ADR-0075: Broken JSON and made-up names are repaired where the meaning is clear
- **Decision:** `parseWithRepairs` tries, in order: the text, raw line breaks escaped, bad escapes fixed, brackets balanced (`balanceBrackets`: a missing closer is added where the next closer shows it was due, a closer with no opener is dropped, an open string and brackets are closed at the end), Python/JavaScript forms (`True`/`None`, trailing commas, single quotes), missing commas between members, and quotes inside values escaped (`fixInnerQuotes`: a quote ends a string only where JSON can go on after it). A call left open at the end of a reply, `{"type":"function","function":…}` and arguments written next to the name are read too. The model is told the first JSON error, not one from Depo's guesses. Made-up tool names that clearly mean a real tool run as that tool (`agent/aliases.ts`: `create_file`→`write_file`, `cat`→`read_file`, `ls`→`list_dir`, `str_replace`→`edit_file`, `exec`→`run_command`, `add_table`/`create_table_*` with a path and content→`append_file`, …), with a note in the result naming the real tool; whole content under an "update" name is only taken for a file that does not exist. Argument names are normalised before the tool checks them (`tools/args.ts`: `file_path`→`path`, `text`→`content`, `old_str`/`new_str`→an edit, `cmd`→`command`, "/be/src"→"be/src").
- **Reason:** The owner's run ended on `create_table_skills` and on `Expected ']'`; earlier runs had `add_table`, `list_tables` and quotes inside `search`. Each of these cost a reply of a minute or more and counted towards the limit, though what the model meant was clear.

## ADR-0076: Small models get fewer tools, careful retries, and a larger model when stuck
- **Decision:** A coder of 4B parameters or less (from the tag, else the runtime's parameter size) gets 15 tools (files, commands, preview, page check, test database, remember) plus the owner's skills and MCP tools, instead of 37, and a "How to work" that teaches file blocks and leaves out the tools it does not have. After a reply with no call Depo can run (broken JSON, made-up tools, unfinished blocks, a reply the runtime rejected), the reply is replaced in the history by a one-line stub (small models copy their own broken calls), the advice changes with each try (the right shape with an example, or file blocks for code; then a smaller step; then the simplest step), and the next replies are sampled at temperature 0.2. On the third such reply in a row, the next larger installed model of the same kind (qwen2.5-coder:3b → qwen2.5-coder:7b, at most 14B) takes over until a call runs, then Depo goes back to the small model and its own sampling; both moves are events in the activity. The task stops after 4 such replies, or 5 when a larger model helped. Setting `agent.step_up` (on by default, in Settings under "Small models").
- **Reason:** The owner wants to use the 3B model because it writes 15 to 26 tokens a second on their GTX 1650, against 1.6 for 7B. The 37 tool descriptions were about 20,700 characters (about 6,000 tokens) of a 16K context; the 15 are about 7,900. Re-running the whole message on 7B worked but was slow; one step on 7B and the rest on 3B keeps most of the speed.

## ADR-0077: Retry runs a failed or stopped task's last message again
- **Decision:** `tasks.retry({ id })` works on a task that failed or was stopped and is not running: it clears the error and starts a run whose conversation is everything up to the owner's last request (`forRetry`), without the attempt that followed; notes the owner sent during that attempt go with the request. The copy keeps the files the attempt changed, and the transcript keeps the attempt and its error. The chat shows a Retry bar under a failed or stopped run.
- **Reason:** The owner had to type the long part 1 message again after the 3B run failed ("add retry icon so I don't need to type again").

## ADR-0078: Schema files are checked for foreign keys MySQL will refuse
- **Decision:** After `write_file`, `edit_file` or `append_file` changes a `.sql` file, `foreignKeyProblems` (`tools/sqlcheck.ts`) reads its CREATE TABLE statements and checks every FOREIGN KEY and inline REFERENCES: integer columns must have the same type and sign as the column they reference, string columns may differ in length, anything else must be the same type. Each mismatch is a warning at the end of the tool result, with the exact type to use ("scans.user_id is INT but it references users.id, which is BIGINT UNSIGNED: MySQL refuses this foreign key (error 3780). Declare scans.user_id as BIGINT UNSIGNED."), so the model fixes it before the migration runs.
- **Reason:** In the owner's part-1 run qwen2.5-coder:3b appended four tables with `user_id INT` to a schema whose `users.id` is `BIGINT UNSIGNED`; the finish line's `db:migrate` failed with ER_FK_INCOMPATIBLE_COLUMNS twice and the model never found the cause.

## ADR-0079: Adding to a file needs a read first; comment-only and repeated additions are refused
- **Changed by ADR-0082:** append_file no longer needs a read.
- **Decision:** `append_file` on a file that exists works like `edit_file`: when the file was not read in this task, nothing is added and the result shows the file (so the next try can match its tables), and counts it as read. Text that is only comments and blank lines (`onlyComments`; Markdown, text and data files never count) is refused with a nudge to add the real content or go on. The same `append_file` again on a file that has not changed since is skipped, like a repeated edit.
- **Reason:** The same run added its tables without reading `schema.sql` (so it guessed the `users.id` type), then appended "-- Additional tables as needed" twice.

## ADR-0080: An empty or unfinished answer is not the end of the task
- **Decision:** In an agent that can edit, an empty final answer gets a nudge to go on with the request or say what was built (twice at most). Before the finish line, `checkDone` (`agent/request-check.ts` `missingParts`) lists the API routes the request names (`GET /api/skills/search`) whose path is in no source file of the copy, and, in a Next.js app, the pages it names as list items (`- /skills/[id] : …`) that have no page file (`[id]` matches any dynamic folder, route groups are allowed). While parts are missing the model is told which ones and asked to build them one by one; it goes on while the list gets shorter, with one more try after it stops shrinking, and at most 6 times. Paths for file blocks may now contain `[id]` and `(group)` folders.
- **Reason:** The 3b run stopped after three steps (only the tables) with an empty answer, and Depo accepted it; the request named three routes and two pages that did not exist. Small models stop after the first part of a long request.

## ADR-0081: A reply to Depo's problem report must change something, or a larger model does it
- **Decision:** After the finish line sends problems back, a final answer with no call since then is not accepted: the claim is replaced in the history by "(I answered without changing anything.)", made-up tool results are removed, the model is shown the main problem again (`reportSummary`: the first item and its first error line) and asked to read the file it names and fix it with a real change, at careful sampling. When a step-up model is installed, it takes over until it finishes its fix (it is not sent back after its first call), then the owner's model goes on and the finish line checks again. At most twice in a run.
- **Reason:** After the migrate failure, the 3b model wrote a reply full of made-up `<tool_response>` results ("bun run db:migrate succeeded"), then claimed the tables were fixed, then described a fix it never made, until the finish rounds ran out.

## ADR-0082: Schema additions are repaired, not refused
- **Decision:** `append_file` no longer needs a read first (this part of ADR-0079 is dropped). On a `.sql` file, CREATE TABLE statements for tables the file already has are left out (if nothing else is left, nothing is added and the model is told to go on), and integer foreign key columns of the added tables get the type of the column they reference (`matchForeignKeyTypes`: `user_id INT` → `BIGINT UNSIGNED` like `users.id`); both are said in the result. File blocks: Git's conflict layout (`<<<<<<< HEAD`, `=======`, `>>>>>>> …`) is read as SEARCH/REPLACE; a block for a `.sql` file whose old text is not in the file, and a labelled `schema.sql` pasted whole (for a block cut off while streaming, only its finished statements), become one `append_file` of the tables the file does not have (`newTables`). The file is never saved over from a paste. A labelled block for an existing `.sql` file does not stop the reply as pasted code.
- **Reason:** In the second part-1 run on the owner's PC, qwen2.5-coder:3b's first call was a correct `append_file` of the four tables with one wrong key type, and the read-first rule refused it. The refusal told it to copy text into `search`; it then wrote the tables as a Git conflict block and as a pasted `schema.sql`, none of which was saved, and the run ended with no tables.

## ADR-0083: A larger model builds a part the small one stalls on; an unfinished request is never "ready"
- **Decision:** When the request check (ADR-0080) finds the list did not get shorter and a step-up model is installed, that model is asked to build the first missing part (at most twice a run, `stepUpFor = "part"`); it keeps going through its calls until it answers, then the owner's model goes on. The check may now ask up to 10 times. When the run still ends with parts missing, the chat gets "Not finished:" with the list and "Send "go on" to continue". The readiness report has a new check, "The request" (`requestCheck`): the routes and pages the task's request and its latest message name, checked in the copy; any missing one fails it, so the Depo reviewer says "Not ready".
- **Reason:** The same run ended "Changes ready for review: 45 files" and "Ready with 3 warnings" though none of the four routes or the skill page existed: the 45 files were the blueprint and lockfiles. 3b had stopped twice without building anything, and nothing told the owner.

## ADR-0084: Depo keeps fixing errors while fixing gets somewhere
- **Decision:** The finish line no longer stops after two rounds. `FixRounds` (`agent/finish.ts`) sends the problems back for as long as they change; when the same problems come back (`problemKey`: the first line and the first error line, numbers ignored), the model is told its fix did not work and to look for another cause, and the larger installed model takes that round (`stepUp` on the retry, kept until it says the fix is done, ADR-0081). Depo stops only when the same problems have come back 3 times after a fix, or after 12 rounds, and the run report then says why and "Send "go on" to keep fixing". Every round adds 20 steps (`FIX_STEPS`), so fixing is not cut short by the steps the building used. When a run ends out of steps, Depo runs the app anyway and, while it finds problems that fixing can get past, the loop goes on with 20 fresh steps and the report open (`runUntilWorking`, `LoopParams.fixing`). In team modes the problems Depo finds at the end go to the coder model (`fixAfterTeam`), which fixes them the same way, instead of only being reported. An idle answer is pushed back up to twice per report. The owner's Stop button ends any of this at once.
- **Reason:** The owner: "if the system brings an error, it should not stop; the agents should read the error and fix it again and again until everything is working". Before, Depo gave up after two fix rounds, after the step limit even with errors left, and never sent team-mode errors back to an agent.

## ADR-0085: A change that breaks a JS/TS file that compiled is not saved
- **Decision:** After `write_file`, `edit_file` or `append_file` changes a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` or `.cjs` file, Depo parses it with Bun's own parser (`tools/syntax.ts`, `Bun.Transpiler`; the engine runs on Bun). When the file compiled before and does not now, the old text is put back and the call fails with the error, where the name was first declared ("do not import or declare it a second time") and the numbered lines around it. A new file, or one that did not compile before either, is kept with a warning and the lines. Depo's problem report from the finish line adds the numbered lines each `file:line` in the output points at (`withCodeFrames`: the copy's own path is cut first, paths relative to a part such as `be/` are found too). `write_file` also refuses a Next.js page under `pages/` when the app has an `app/` router (with the path it should have, `fe/app/skills/[id]/page.tsx`), and code with functions left for later ("// Add implementation here"). The readiness card's "Run tests" runs in each part with a test script when the top folder has none (`testRuns`), as the finish line does.
- **Reason:** In the owner's third part-1 run qwen2.5-coder:3b appended `import { createApp } from './app'` and a default export to the blueprint's `be/src/app.ts`, which already declares `createApp`. The backend tests failed, and in three fix rounds neither 3b nor 7b removed the lines (they wrote half SEARCH/REPLACE blocks), so Depo stopped. The same run put pages in `fe/pages/` and stub files with "// Add implementation here", and "Run tests" on the readiness card ran `bun run test` at the top of the copy ("Script not found").

## ADR-0086: Depo plans a request into steps, shows the plan first, and checks each step in code
- **Decision:** A request with at least two parts to build (or "go on" after a plan that was not finished) runs as a step plan. `agent/plan.ts` (`buildPlan`) splits the request text into steps without a model: from its headings and bullets, a table step per data item with columns ("Add the favorites table"), a route step per `GET /api/...` item, a page step per page item, a build step for a page section's shared lead text or a trailing instruction, one test step per part of a Tests section, "Build the <section>" for any other section, and always "Run the app and check it" last (at most 40 steps). The plan is stored on the task (`tasks.step_plans`, migration 11, one `StepPlan` per turn, the last 20 kept) and shown above the work in the chat as a checklist (`StepPlanCard`: done, working on with the try and the model, not done yet with the reason, to do, skipped, an "added" badge for steps Depo added). Each change saves the plan and sends a cleared `stepPlan` event that refreshes the card without adding a line to Activity.
  `agent/step-runner.ts` (`runStepPlan`) runs each step as a short run of its own: a fresh conversation with the coding system prompt (`steps: true`) and the step prompt (`agent/step-prompt.ts`: "Step 3 of 19", the step's part of the request, the overview, what is done and what comes later, how to do this kind of step, and the files it works on already read: the schema's end for a table, the route file and the stores for a route, the app folder's page and layout for a page, a test file for tests, files the text names). The tools are scoped to the step (`ToolContext.step`: the tables it may add, its schema file, its main file). When the model says it is done, `agent/step-check.ts` (`checkStep`) checks it in code: the CREATE TABLE is there, finished, with every listed column, matching key types and short names; the route is in the code; the page file exists; a test file was written; something changed for a build or fix step; every changed file compiles. Problems go back to the model in the same run (`FixRounds` with 6 rounds, the same problem twice brings in the larger model). A table, route or page that is already in the code is marked done without a model call.
  A step that still does not pass climbs a ladder: the larger installed model starts it again from the step's save point (`agent/savepoint.ts`: the copy's own files before the step, in memory, without node_modules, build output or Depo's data), then the owner's model starts it again carefully (temperature 0.2), with what the earlier tries ran into. A step that fails every rung is parked (its work is kept only if it compiles) and the other steps go on; parked steps are tried again after the others, when later steps may have made what they lacked. Then Depo runs the app (the finish line); each problem it finds, up to 4 a round, becomes a "Fix:" step added to the plan before the check, which runs again after them, until the app runs clean or `FixRounds` says the same problems keep coming back. The chat ends with "Done: all N steps passed Depo's checks", or the steps not done with why and "Send "go on"", which continues the same plan from its first unfinished step. Depo's messages to the model are stored with `fromDepo` and shown as `tester@depo` items, not as the owner's.
- **Reason:** In the owner's fourth part-1 run qwen2.5-coder:3b got the whole 6,000-character request at once: it invented tables with names too long for MySQL, wrote ALTER TABLE IF NOT EXISTS, put a Next.js route file in the Bun backend and stopped with replies that were only a code fence, and nothing showed what Depo was going to do. The owner asked for Depo to work like Claude: show the whole plan first, add steps when more is needed, and fix until everything works. A small model does far better with one short, concrete job and its files in front of it, and a check in code after each step finds a wrong step while it is still small.

## ADR-0087: Guards for the fourth part-1 run
- **Decision:** `tools/sqlcheck.ts` `longIdentifiers` finds table, column and key names over MySQL's 64 characters, and the name MySQL gives an unnamed foreign key (`<table>_ibfk_1`); `append_file` refuses such an addition ("Nothing was added") and a `write_file` or `edit_file` of a `.sql` file that adds one is undone ("is as it was before"). `invalidStatements` leaves out `ALTER TABLE IF NOT EXISTS`. In a table step `onlyTables` keeps only that step's CREATE TABLE and its indexes and says what it left out. An `append_file` call with no path goes to the step's schema file (SQL) or main file, and the result says so (`inferAppendPath`). `write_file` refuses a Next.js-style `app/api/...` or `pages/api/...` file in a backend that is not Next.js and has its routes in `src/app.ts` (or server/index), naming that file. The loop treats a reply that is only a code fence as empty; the second empty reply in a row goes to the larger model.
- **Reason:** These are the mistakes 3b made in that run: `ER_TOO_LONG_IDENT` from a foreign key on a 60-character table, ALTER lines MySQL cannot read, `append_file` calls without `path`, `be/src/app/api/skills/search.ts` in a Bun backend, and replies of only "```json".

## ADR-0088: The Manager's plan never hangs, and shows its progress
- **Decision:** The Manager's structured answers (the plan, a note, a review read back) are asked with `think: false` (a thinking model answers straight away; Ollama gets `think`, and a 400 that refuses it is asked again without it) and at most 4,096 tokens. A model that has not started its answer after 3 minutes, or not finished it after 10 (`MANAGER_LIMITS`, counted from when the model starts on it), is stopped (`ManagerTooSlow`) and Depo goes on: for the plan, with the standard steps and the warning "qwen3:4b thought for 3 minutes without starting its answer, so Depo uses the standard steps and starts the work". While the Manager plans, one live line updates every 2 seconds in the chat and in Activity ("Manager is reading the request (4 s)", "Manager is thinking about the plan (about 420 words, 1 min 20 s)", "Manager is writing the plan (1,234 characters, ...)"), from the stream's progress (`generateObject` `onProgress`). The model gateway now has a `thinking` chunk: Ollama's `message.thinking` and llama.cpp/LM Studio's `reasoning_content` become thinking chunks, never answer text, and a `<think>...</think>` part inside the answer is left out before the JSON is read (`withoutThinking`). Any agent's thinking counts on its waiting line too ("Thinking, about 300 words" in the chat), never in its reply. A model call that is cancelled is logged at info with how far it got (`thinkingChars`, `replyChars`). The readiness check's test run uses the parts (be/, fe/) for a remembered `bun run test` as well; it ran that at the top of the copy, where there is no package.json, so it always failed in about 100 ms while the finish line's runs in the parts passed. Stop during any model call marks the task stopped ("Stopped by the user"), not failed with "Cancelled".
- **Reason:** The owner's first Full system run (qwen3:4b as the reasoning model on a GTX 1650) showed "Manager is planning the work" for 11 minutes and nothing else; the log had no model call at all, because the call never finished. qwen3 thinks before it answers and Depo neither turned that off nor read the thinking, there was no limit on the plan call, and the Stop that followed was recorded as a crash.

## ADR-0089: Each task keeps its own unsent message
- **Decision:** The chat composer's text, work mode and attached pictures and links are a draft per task, and one per project for the new-task composer (`store/composer.ts` `useDrafts`, `draftKey`). The draft stays when the chat screen closes (another tab) or another task opens, and never shows in another task. Sending clears only the draft that was sent. Text and mode are also kept in the browser's storage (`depo.composer.drafts`) so they survive a restart; pictures stay for the session. Pictures added while one task is open go to that task's draft even if the owner switches before they finish loading.
- **Reason:** The owner: text and pictures typed in the chat were gone after visiting another tab, and text typed for a new task appeared in the old task when they went back to it. The composer kept its draft in component state, which a tab change threw away and a task change carried over.

## ADR-0090: "Done" means a file changed; steps keep the design references
- **Decision:** A single agent's run that was asked to build or change something (`asksForChange`: a change verb, or attached pictures or links; a question ending in "?" is not) and changed no file is not done (`stillToDo` adds `NOTHING_CHANGED`): the model is sent back once with "Not done yet: no file has changed" (`notDoneNote`), and the run ends with "Not finished ... the change itself". A follow-up is judged by its own words (`latest`), so "how does the login work?" after "build a login" asks for nothing. The team's fix run keeps checking only the named parts (`missingParts`). A tool call written as text at the end of a reply (an unclosed `{"name": ...}`) counts as an unknown tool call (`openTail`). In step mode the owner's design references brief goes into the prompt of every page, build and fix step (`stepPrompt` `design`).
- **Reason:** The owner's login-system run: qwen2.5-coder:3b wrote `{"name": "safe-file-edits", ...}` as text, nothing changed, and Depo showed the run as done with the starting project's screen. In step mode the reference pictures never reached the steps that build the screens.

## ADR-0091: Stop and Discard leave nothing behind; a starter is built with the first task
- **Decision:** When a task is stopped (or Depo closes while it works), its running apps stop first (`TaskManagerOptions.onStopped`: Depo's auto previews and every unpinned preview of the task), then what that run wrote leaves the private copy: a copy made by this run is removed (the task's `workspacePath` is cleared), a reused copy goes back to the save point taken when the run started (`runCopies`, `takeSavePoint` / `restoreSavePoint`), and earlier turns' work stays reviewable. "Stopped by the user" is followed by "Cleared the private copy ..." or "Took this run's work out of the private copy ...". The setting `tasks.keep_stopped_work` (off) keeps the old behaviour. Discarding a change set removes the task's private copy too (`TaskManager.resetCopy`), so the next message builds from the project as it is. A project created from a blueprint gets only a README (and `git init`) in its folder; the blueprint is the project setting `starter`, and the first task's `kickstart` writes it into the empty private copy whatever the request says, so the starting project and the work arrive in one review (`createFromBlueprint` `writeFiles` keeps the old way for scripts).
- **Reason:** The owner: "it should build from 0 and should delete what in the shade when we close or stop it", and the be/fe starter should "be built in the shade with him, not locally, and all come together at one time". A stopped run left half-done work in the copy that the next run continued from, discarded work stayed in the copy, Stop left the apps running, and every project began with the starter already committed in its folder.

## ADR-0092: Code checks run at review, UX from the page check, ports never fixed, clearing logs
- **Decision:** At review the readiness service runs the installed compilers and linters on the task's copy before it records its decision (`DiagnosticsSource.run`, at most 4 minutes, a live "Depo is running the code checks" line); with no checker installed the code check says so ("not_run", never "pass"). Without a UX agent's score for this change, the UX check uses a score Depo works out from its own page check (`pageUxScore`: loading at every width, accessibility, console errors, failed requests; it never blocks on its own). A dev script that fixes its own port (`next dev -p 3000`, `vite --port=5173`) runs as the binary with Depo's free port (`ownPortCommand`); chained scripts run as written. The coder's playbook says ports come from `PORT` and the API address from an environment variable. `logs.clear` deletes the rotated log files and empties the current one (Logs tab "Clear logs", asked once); the Activity feed's "Clear" hides what is shown so far (kept in the browser, `depo.activity.clearedAt`, "Show earlier" undoes it) and deletes no evidence. `TaskManager.settled` also waits for the readiness decision.
- **Reason:** The owner: "the code checks and the UX are always unchecked", "when I open another one while the old port is working the system should find an empty port", "the fixed be / fe should be able to be changed by the system", and "I should be able to delete / remove the old logs".
