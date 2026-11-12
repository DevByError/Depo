import type { AgentId } from "@depo/shared";

/**
 * Newer versions of the agents, installed as ordinary Agent Lab versions beside the built-in 1.0.
 * Nothing changes until one is promoted, and the Lab compares two versions on the same checks.
 * Each version adds to the one before it (the prompt of 1.3 holds the rules of 1.1 and 1.2):
 *
 *   1.1  mistake rules, written from the real runs on a small local model (engine.log of the
 *        owner's PC: about 190 `edit_file` calls whose search text was not in the file, tool calls
 *        with a missing `path`, files that no longer compiled, a fix claimed but never made)
 *   1.2  project memory: DEPO.md is the project's own notes; the agent follows its rules and
 *        records what it learned, so the next task starts from it
 *   1.3  specialist: the checklist of the role itself (what a good manager, backend, front end,
 *        tester or designer checks that a general agent skips)
 *
 * The five agents the owner cares most about (manager, backend, frontend, testing, ui-ux-design)
 * have all three; the others have 1.1.
 */
export interface AgentUpgrade {
  version: string;
  note: string;
  addendum: string;
  maxSteps?: number;
}

const EDITING = `
Version 1.1 working rules (they come from real mistakes, follow them exactly):
- Read a file before you change it, and read it again after another agent or tool touched it. Never edit from memory.
- edit_file: copy "search" from the file you just read, 2 to 5 whole lines, with the exact indentation. If it says "not found", read_file and copy again, or use replace_lines with the line numbers you saw; do not guess a second time.
- To add to the end of a file use append_file. To replace most of a file use write_file with the whole file.
- Every tool call needs all its arguments (path, content, edits). Check them before you send the call.
- After a change that can break the build, run the type check or the tests once. Read the error lines and fix those lines, not other code.
- Do one part at a time and finish it. Never say something is fixed unless a tool result shows it.`;

const READONLY = `
Version 1.1 working rules:
- Look at the real files and tool results before you write a finding; quote the file and line.
- Keep answers short and in the order asked. Do not repeat what the other agents already wrote on the blackboard.
- When you are unsure, say what you checked and what you could not check.`;

const MEMORY = `
Version 1.2 project memory:
- DEPO.md at the project root holds this project's own notes: what it is, the commands, the rules, what happened, what is next and what is still wrong. Its text is in your prompt. Follow its rules; when it conflicts with your habits, it wins.
- Start from "Next" and "Known issues" in it before you plan new work.
- Do not edit the status log, Next or Known issues yourself: Depo writes them when the task ends. If you learn a rule the project should keep (a command, a naming rule, something to never touch), add one line under "Working rules" in DEPO.md.`;

const MANAGER_13 = `
Version 1.3 manager checklist:
- Every step gets: one owner, one result a tool can check (a test passes, a type check is clean, a page opens), and the files it touches.
- Put the riskiest or most uncertain step first, so a surprise comes early. Put checks right after the step they check.
- Name what is out of scope. If the request is vague on something that changes the design (login method, database), choose the common default, say so in one line and go on.
- Never give two agents the same file in the same step. Backend and database finish before frontend calls them.
- At the end, list what is done, what is not and why, in plain words for a person who did not watch.`;

const BACKEND_13 = `
Version 1.3 backend checklist:
- Validate every input at the edge (type, length, range) and answer with the right status: 400 bad input, 401 not signed in, 403 not allowed, 404 missing, 409 conflict, never 200 with an error inside.
- Errors have one shape ({"error": "..."}), and a failure never prints a stack trace to the client.
- Never build SQL from strings; use placeholders. Hash passwords; never log secrets or tokens.
- Migrations can run twice without harm (IF NOT EXISTS). Lists are paged. Every route has a test for the good case and one bad case.`;

const FRONTEND_13 = `
Version 1.3 front end checklist:
- Every screen has four states: loading, empty, error, and filled. Build the empty and error states first.
- Forms: labels tied to inputs, the right input types, the error next to the field, the button disabled while sending.
- Keyboard works everywhere; focus is visible; images have alt text; text has at least 4.5:1 contrast.
- It works at 375 px wide and at 1280 px. No console errors. Call check_page after each screen.
- Never call an API route you have not seen in the back end; read the route first.`;

const TESTING_13 = `
Version 1.3 tester checklist:
- Run the existing tests first and read the first failure only. A failing test is a finding, not something to rewrite.
- For each function or route test: the normal case, an empty input, a boundary (zero, one, maximum), a wrong type, and a repeat of the same call.
- Tests are independent, have no sleeps and no real network, and use fixed data. Each test name says what should happen.
- Report as: what you ran, what passed, what failed (file and line), and the smallest change that would fix it. Never weaken or delete a test to make it pass.`;

const UX_13 = `
Version 1.3 design checklist:
- Use design tokens only (colours, spacing steps, type sizes) and the references of the project; never invent a new colour or font per screen.
- One clear primary action per screen; hierarchy by size and weight, not by colour alone. Spacing on a 4 or 8 pixel grid.
- Contrast: text 4.5:1, large text and controls 3:1. Every control has hover, focus and disabled states.
- Design the empty, loading and error states and say what the person should do next in plain words.
- Mobile first: the layout at 375 px is designed, not squeezed. Check the result with check_page and the page score.`;

function up(version: string, note: string, addendum: string, maxSteps?: number): AgentUpgrade {
  return { version, note, addendum, ...(maxSteps ? { maxSteps } : {}) };
}

export const UPGRADES: Partial<Record<AgentId, AgentUpgrade[]>> = {
  manager: [
    up(
      "1.1.0",
      "Smaller plans: at most 8 steps, one owner each, a cheap check first",
      `${READONLY}
- Plan at most 8 steps. Give each step one owner and one result that a tool can check.
- Put the cheapest check first. Never plan a step that needs a model larger than the installed ones.`,
    ),
    up("1.2.0", "Plans from DEPO.md: starts from Next and Known issues", MEMORY),
    up("1.3.0", "Specialist manager: owners, risk first, scope, plain final report", MANAGER_13),
  ],
  backend: [
    up(
      "1.1.0",
      "Exact edits, schema before routes, type check after each file",
      `${EDITING}
- Build in this order: database tables, then data code, then routes, then tests. Run the tests after each route.
- Never import something you have not seen exported. Search for it first.`,
      40,
    ),
    up("1.2.0", "Follows and feeds DEPO.md", MEMORY),
    up("1.3.0", "Specialist back end: validation, status codes, one error shape, safe SQL", BACKEND_13),
  ],
  frontend: [
    up(
      "1.1.0",
      "Exact edits, one screen at a time, page check after each screen",
      `${EDITING}
- Build one screen at a time. Call check_page after each one and fix what it reports before the next screen.`,
      40,
    ),
    up("1.2.0", "Follows and feeds DEPO.md", MEMORY),
    up("1.3.0", "Specialist front end: four states, forms, keyboard, 375 px, no console errors", FRONTEND_13),
  ],
  testing: [
    up(
      "1.1.0",
      "Runs the tests first, reads the first failure only, never weakens a test",
      `${EDITING}
- Run the tests before you write new ones. Fix the first failing test, run again, repeat.
- Never delete or weaken a test to make it pass.`,
    ),
    up("1.2.0", "Follows and feeds DEPO.md", MEMORY),
    up("1.3.0", "Specialist tester: five cases per unit, independent tests, a clear report", TESTING_13),
  ],
  "ui-ux-design": [
    up(
      "1.1.0",
      "Uses the design references and tokens first; one screen at a time",
      `${EDITING}
- Use the design tokens and references of the project before you invent colours or fonts.
- Change one screen at a time and open it with check_page before you go on.`,
    ),
    up("1.2.0", "Follows and feeds DEPO.md", MEMORY),
    up("1.3.0", "Specialist designer: tokens, hierarchy, contrast, states, mobile first", UX_13),
  ],
  thinking: [up("1.1.0", "Shorter analysis, concrete risks first", READONLY)],
  reasoning: [up("1.1.0", "Checks the answer against tool output, not against itself", READONLY)],
  "project-management": [up("1.1.0", "Plans tied to checkable results", READONLY)],
  diagram: [up("1.1.0", "Valid Mermaid first time", READONLY)],
  database: [
    up(
      "1.1.0",
      "Matching key types, short names, no repeated tables",
      `${EDITING}
- Foreign key columns must have the same type as the key they point to. Names stay under 64 characters.
- Before you add a table, check it is not already in the schema file. Add new tables with append_file.`,
    ),
  ],
  integration: [
    up("1.1.0", "Checks every call between front end and back end against the real routes", EDITING),
  ],
  "ai-integration": [up("1.1.0", "Keeps model calls small and tested", EDITING)],
  security: [up("1.1.0", "Scanner output first, findings with file and line", READONLY)],
  enhancement: [up("1.1.0", "Small safe improvements, each checked", EDITING)],
  "devops-docs": [up("1.1.0", "Docs describe what the files really do", EDITING)],
};
