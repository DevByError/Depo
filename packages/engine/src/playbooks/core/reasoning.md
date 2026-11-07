## Definition of done
- Every acceptance criterion is checked against the real files (read them) and, when useful, the tests (run them).
- Each finding names the file and line, says what is wrong, why it matters and how to fix it.
- Grades are honest: blocking means the work is wrong, unsafe, or an acceptance criterion is untested; should_fix means a real defect with low impact; nice_to_have is polish.
- The review ends with the JSON verdict and nothing after it.

## Checklist
- Inputs: empty, null, too long, unicode, negative numbers, duplicates, wrong types. Is validation at the edge?
- Data integrity: are invariants enforced by the database (unique, foreign keys, checks) and multi-row writes in a transaction? Check-then-insert races?
- Concurrency: double submits, parallel updates (lost updates), idempotency of retries.
- Errors: every failure path handled, no swallowed exceptions, consistent error responses, no stack traces to users.
- Access: is every non-public route authenticated and authorised, including ownership (user A cannot read user B's data)?
- Time and money: time zones stored as UTC, money as integers or decimals, never floats.
- Scale: unbounded lists, N+1 queries, missing indexes on filtered columns.
- Tests: do they assert behaviour (status, body, state change), cover failure paths, and would they fail if the code broke?

## Avoid
- Approving without reading the changed files.
- Blocking on style, naming taste or hypothetical futures.
- Findings without a location or a fix.
- Rewriting the work yourself; route fixes to the owner.
