# Making Depo faster and more accurate

Written 2026-11-13 from the owner's real `engine.log` (about 1,430 coder calls on a GTX 1650 4 GB).

## Status of every idea (2026-11-13, second round)

| Idea | Status |
|---|---|
| Send only the tools a step needs | Done: `stepTools` in `agent/step-runner.ts` (route, table and tests steps drop preview, page check, database console, memory, delete) |
| Read a file again only when it changed | Done: `read_file` answers "has not changed since you read it" for the same lines within 3 reads |
| File region in the "not found" error | Done: the error shows the lines around the nearest matching line, with numbers |
| Edit by line range as a fallback | Done: new `replace_lines` tool (read first, compile check, undo on a break); small models get it too |
| Say how to know a step works | Done: every table, route, page and tests step prompt ends with "You know the step works when ..." |
| Warn under 3 tokens a second | Done: one warning per model in engine.log |
| Agent Lab checks from real failures | Done: exact-search, read-first, not-found (backend, frontend, database) and foreign-key type checks, so 1.1 must beat 1.0 on the mistakes seen |
| Detect a dying runner early | Already there (`models/revive.ts` restarts and shrinks the context); the 144 minutes were mostly Ollama timing out on connect, which Depo cannot shorten from outside |
| 8k context for small models | Not done on purpose: the window size does not make a call faster, the prompt size does, and that is cut by the history trim |
| Auto-Fit by prompt-reading speed | Not done: needs measured speeds on the owner's PC first (the log now has `promptTokensPerSec` to build it from) |
| Run checks while the model reads | Not done: the step checks need the files the model just wrote; the gain is small against the risk |
| One owner per file in team runs | Not done: needs a lock in the team runner and a real team run to tune |
| Few-shot finished file in the step prompt | Already there: the files a step works on are shown whole as exact text |
| Rank lessons by error text | Not done: the memory store holds lessons, ranking needs real runs |

## Where the time went (measured)

| What | Number | Meaning |
|---|---|---|
| Prompt tokens vs generated tokens | 5.8 million vs 243,000 | Reading the history again on every call costs far more than writing |
| Median prompt per call | about 7,800 tokens | A history that is heavy on every step |
| Calls over 8k prompt tokens | about 230 minutes of waiting | Half of all waiting on the big prompts |
| `edit_file` failures | 241 (190 "search text not found") | Each one is a whole model call of 1 to 2 minutes |
| Failed or retried model calls | 229, about 144 minutes | Ollama dropped the connection, timeouts, crashes |
| 7b model | about 1.6 tokens a second | Slower than the 3b by 10 times on this GPU |

## Done in this round

1. **Forgiving edits.** Wrong indentation or spacing in a search block is matched anyway (four tiers). The biggest single source of wasted calls.
2. **Lighter history.** Old tool outputs shrink at 40% of the window (was 70%), in one step, so the prefix cache still works.
3. **Exact errors.** A failed task shows the message, code, cause chain and where it came from.
4. **Ask once.** One question at the start of a task; "yes" means no more prompts for that task (or project). Changes still wait for Diff Review.
5. **Agent version 1.1** for all 15 agents, with rules written from the mistakes above, installed beside 1.0 so they can be compared in Agent Lab before one is promoted.
6. **Showcase screen** with real numbers and the feature list for the manager.

## Next ideas, in order of expected gain

### Speed
1. **Embed the file once, not on every read.** Keep a "files already read" summary and let `read_file` return only the changed lines of a file read earlier in the task.
2. **Stop re-sending the tool list.** 38 tool definitions travel with every call. Send only the 8 to 12 tools the current step needs (the step plan knows if it is a test step, an edit step or a read step).
3. **Use the 3b for almost everything, the 7b only for the one step that failed twice.** Already partly done (step-up); make the 7b call a single short step instead of continuing the whole run, then return.
4. **Prompt-reading speed in Auto-Fit.** Choose the model and context size by measured prompt tokens per second on this PC, not only by memory fit. A 16k context on 4 GB spills to the CPU.
5. **Smaller context (8k) with better trimming** for the small models: faster, and the history can no longer grow past what is useful.
6. **Detect a dying runner early.** After the first ECONNRESET restart the runner and reload the model once instead of waiting for time-outs (144 minutes were lost on failed calls).
7. **Run the checks in parallel with the model.** The type check and the tests of step N can run while the model reads for step N+1.
8. **Warn when a model writes under 3 tokens a second** and offer the smaller model.

### Accuracy (fewer mistakes)
1. **Show the model the file region, not the file.** For an edit, give 40 lines around the target and the exact line numbers; most "not found" errors come from copying from memory.
2. **Edits by line range for small models** (`replace lines 12-18 with ...`), checked against the compile result, as a fallback when search text fails twice.
3. **Run the compiler after every file, tell the model only the first error with its code frame** (already done on writes; extend to the test runner output).
4. **Test first.** For each step the plan writes one tiny check (a test or an HTTP call) before the code, and the step is done only when it passes.
5. **Few-shot from the project itself.** Put one finished file of the same kind (a route, a page, a test) in the step prompt; small models copy a pattern much better than they follow a rule.
6. **Learn from fixes.** Keep each repaired mistake (the error and the change that fixed it) and show the model the nearest ones next time (the memory store already holds "lessons"; rank them by error text).
7. **Check agents against evals before promoting.** Grow the Agent Lab suites from real failures in the log (the 190 "not found" cases make a ready test suite) and require 1.1 to beat 1.0 before it becomes the default.
8. **One owner per file.** In team runs only one agent may edit a file at a time; reviewers write comments, not edits.

### Process
- After every real run, read `engine.log` with the script pattern used here (calls, minutes, failures by tool) and add the top failure to the next round. The Showcase screen shows the same counts live.
