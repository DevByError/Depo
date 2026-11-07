# Upgrade rounds (2026-11-07)

The owner asked for three rounds: build everything, then judge whether Depo is a very advanced coding tool, find what would make it ten times better, build that, test everything together, and repeat once more.

## Round 1: what was built

Claude-style chat (stick-to-bottom, one-line expandable work log, plan card, composer with work-mode menu), Team view (decision events, `team.timeline`, live task graph, agent cards, decisions timeline), Preview (run recipes, preview manager on loopback, Preview tab with link and viewer, agent tools to start the app and test it over HTTP), agent playbooks (a core per agent, 27 topics, budgeted loading, `read_playbook`), a production bar for build plans, automatic memory, structured logs (Logs tab, diagnostics export, model timings), a new look (slate and teal, IBM Plex Sans, agent colours, tool rail, drawers on small windows). Verified: engine 309, UI 115, e2e 17.

## Round 2: assessment

Where Depo now stands against the strongest coding agents (Claude Code, Cursor, Devin, Replit Agent, Lovable):

- **Ahead or unusual:** fully local with a 15-agent team that plans, reviews with two keys and records its decisions; shadow workspaces with per-hunk apply and checkpoints; previews of a task's private copy before anything lands; security scanning, UX audits, Agent Lab, building blocks, skills, MCP, knowledge packs.
- **Behind:**
  1. The owner cannot steer an agent while it works; a new message has to wait or stop the run.
  2. Diff Review has no line comments; feedback is a new chat message that loses the context of the line.
  3. Agents never look at the UI they build: no screenshots of the running app, no console errors, no accessibility check of the real page.
  4. The link to the running app is not offered automatically when work is ready.
  5. Imported projects are not understood structurally: no dependency graph, entry points, cycles or hot spots.
  6. The Project tab is a settings page more than a home: no health, trends, running previews or recent decisions.
  7. A team run can only be watched live; there is no way to replay how the team reached its result.
  8. On a modest GPU nobody knows how long a run will take.
  9. Search is split across screens (files, memory, logs, tasks).
  10. Approved changes do not become git history; the owner commits by hand.

## Round 2: ideas picked (11)

1. Steering notes while an agent works, delivered at the next step (single and team).
2. Decline reasons on approval cards, which feed self-memory.
3. Pull-request style review: line comments in Diff Review and "Request changes".
4. Visual QA: a small DevTools Protocol client, `check_page` (screenshots at phone, tablet and desktop, console errors, failed requests, axe accessibility), thumbnails in chat.
5. Automatic preview of the private copy when work is ready, with "Open the running app" in chat.
6. Code map: import graph from the index, modules, cycles, hot spots, `code_map` tool for agents.
7. Auto architecture diagram from the code map.
8. Project home: health cards, previews, tasks, decisions, memory highlights, code map.
9. Team replay: a scrubber that rebuilds the graph, agent cards and decisions at any moment.
10. Time estimates learned from this PC's real speed, before and during a run.
11. Universal search in Ctrl+K and git commits with a drafted conventional message.

## Round 2: what was built

All eleven ideas, in five parallel worktrees, merged and tested together: steering notes (single and team), decline reasons, line comments with "Request changes", visual QA with a DevTools Protocol client and axe (`check_page`, thumbnails, "Check this page"), automatic preview with "Open the running app", code map with an auto architecture diagram and the `code_map` tool, the Project home, team replay, time estimates learned on this PC, Ctrl+K universal search, and git commits with a drafted message plus a History tab. A screenshot pass then gave Diff Review more room, sharpened command matching, made the Preview tab open on the running copy and closed the bottom panel by default. Verified: engine 417, UI 206, e2e 17.

## Round 3: assessment

After round 2 Depo steers, reviews like a pull request, sees the app it builds and understands the code. What still holds it back:

1. Two bottom tabs are still placeholders: Terminal and Test results. Problems only lists error events, not real compiler or linter findings.
2. Nothing closes the loop from a problem to a fix: a failing test, a type error or a crashing preview has to be retyped as a task.
3. Speed on the owner's GPU is left to chance: models can reload between calls (changing context sizes, no keep-alive), prompts are not ordered for prefix reuse, and the scheduler swaps models freely.
4. Small local models build from a blank page, so "build a task manager" comes out basic. They need strong, tested starting points.
5. There is no single answer to "is this ready to ship?": tests, checks, scores, page checks and the plan's criteria live on different screens.
6. Code has no syntax highlighting in Files, Diff Review or chat, and there is no "ask about these lines" from the code itself.

## Round 3: ideas picked (5 workers)

1. Speed on a modest PC: keep models loaded, one context size per model, prompts ordered for prefix reuse, model affinity in the scheduler, load and prompt-reading times in the model stats.
2. Real Terminal, Test results and Problems tabs, with "Fix with an agent" on any failure.
3. Blueprints: production-grade starting points (API, web app, full stack) that agents extend instead of starting from nothing.
4. Readiness report: one card at review time with tests, checks, security and UX scores, page checks and the plan's criteria, and a plain verdict.
5. Code you can read: syntax highlighting everywhere, the Files tree follows the open file, and "Ask about this" or "Change this" on selected lines.

