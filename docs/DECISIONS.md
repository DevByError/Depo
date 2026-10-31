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
