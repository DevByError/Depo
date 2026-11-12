# Would a RAG system make Depo faster?

Short answer: **yes, retrieval helps, but only the cheap kind, and only for one specific cost.** Depo now has that kind. A full embedding-based RAG is not worth its price on a 4 GB GPU yet.

## What the owner's log says the cost is

From the real `engine.log` (about 1,430 coder calls): 5.8 million prompt tokens were read for 243,000 written, median prompt 7,800 tokens, and about 230 of the 1,330 waiting minutes were calls with prompts over 8k tokens. On a small GPU, **reading the prompt is the slow part, not writing**. Anything that puts fewer, better tokens in the prompt is a speed-up. That is exactly what retrieval does: instead of the whole file or the whole repo map, show the parts that matter for this step.

## What Depo already had

- A repo map (files and symbols) in the system prompt, cut to a budget.
- The `search` tool: symbol matches plus **semantic matches when an embedding model is installed** (chunks of about 60 lines, stored in the `embeddings` table). The model has to ask for it, and most small models do not.
- Step prompts that show the files a step works on, whole, as exact text.

## The gap

`shownFiles` (the files shown inside a step prompt) **skipped any file bigger than the remaining budget**. In a real project the file a route step must change (`be/src/app.ts`) is exactly the big one. The model then had to `read_file` it (more tokens, one more call) or guess its text, and that is where the 190 "search text not found" retries came from.

## What was built (light RAG, no model, no download)

`agent/retrieve.ts`:

1. Cut the file into chunks of about 40 lines at blank lines.
2. Score every chunk against the words of the step (title, spec, notes; camelCase and snake_case are split) with **BM25**.
3. Show the first chunk (the imports), then the best chunks that fit the budget, in file order, with `… (lines 61-120 not shown) …` markers so line numbers stay true.
4. Say in the heading that the file is partial and that `read_file` gives the rest. The shown text is the exact text, so it can be copied into an edit.

It runs in about a millisecond on a 600-line file (tested), needs no embedding model, never loads or swaps a model on the GPU, and is deterministic. A test shows a 30-route, 600-line file reduced to the one matching route plus the imports, under budget.

## Second round (built): a retrieval index over the whole project

The first version only cut files that were too big. The second (`agent/codeindex-lite.ts`) retrieves from the **whole project**:

- **Chunks follow the code.** A function, class, route (`app.post("/api/login")`), SQL table or component is one chunk, named after its symbol (`post /api/login`), not 40 arbitrary lines.
- **Names and paths count triple.** The symbol and the file path are weighted, so "login route" finds the login route before a comment that mentions login.
- **BM25 over every chunk of the project**, so the telling, rare words win (idf from the whole project).
- **Ranking rules:** files changed in this task rank higher, test files lower unless the question is about tests, at most two chunks of one file, and a file already shown whole is left out.
- **Cached by size and modified time:** a second question costs a few `stat` calls.
- **Three places use it:** the step prompt ("Related code already in this project": how the project already does the same kind of thing, to match its names and style), the `find_code` tool (the model can ask), and the not-found edit error (the lines around the nearest match).

## Writing code with no model at all

The fastest code is code the model does not write. `agent/tablegen.ts` writes a **table step by itself** when the schema is MySQL/MariaDB style: types follow the column names (`id`, `*_id`, `created_at`, `is_*`, `email`, `description`, `price`, ...), a column like `skill_id` becomes a real foreign key to the table that exists, key types match the referenced id, names stay under 64 characters. It is checked like any model's work; if the check fails the file is put back and the model does the step. Off with `agent.generate_tables = false`.

## Why not full embedding RAG yet

| | Lexical (built) | Embeddings |
|---|---|---|
| Needs a model | No | Yes: an embedding model beside the coder; on a 4 GB card it either swaps with the coder (tens of seconds each way) or runs on the CPU |
| First-use cost | None | Index the whole project (minutes), keep it fresh on every file change |
| Good at | A step that names routes, tables, functions, pages (Depo's steps do: "GET /api/skills/search") | A question in words that share nothing with the code ("where do we check permissions?") |
| Failure | Misses a synonym | Returns plausible but wrong chunks; hard to see why |

Depo's plan steps already carry identifiers, so lexical retrieval fits them. Embeddings stay available through the `search` tool for open questions.

## What to expect, and how to check

Expected: fewer `read_file` calls for big files, fewer "not found" edits, and a lower median prompt. This is **not measured on a real model yet**. To measure: run the same request before and after on the owner's PC and compare in `engine.log` the median `promptTokens`, the number of `tool call failed` for `edit_file`, and the total minutes of `model call`.

## Next steps, in order

1. Measure the above on a real run. If the median prompt is still over 5,000 tokens, apply the same retrieval to the **repo map** (rank symbols by the step's words instead of cutting by size).
2. Retrieve **past fixes** (the memory store's lessons) by the error text, so a repeated error shows the fix that worked.
3. Retrieve from **DEPO.md** and the **knowledge packs** with the same BM25 (they are text already; knowledge packs use FTS5 today).
4. Only if 1 to 3 are not enough, add embedding re-ranking of the top 20 lexical chunks (small embedding model on the CPU, no GPU swap).
