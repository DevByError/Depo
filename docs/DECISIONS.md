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
