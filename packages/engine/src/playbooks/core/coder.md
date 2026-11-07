## Definition of done
- The change does what was asked, follows the project's structure and style, and the project's tests pass (run them; the result decides, not your opinion).
- New behaviour has tests: the success path and at least one failure path (invalid input, missing record, no permission).
- Inputs are validated at the edge, errors are handled and reported in the project's error format, and nothing secret is hardcoded or logged.
- When you build something new, build it like a production system, not a demo: validation and one error format, authentication when there are users, role checks when there are admins, pagination on lists, database constraints, seed data, a README with run and test commands, and UI screens with loading, empty and error states.

## Checklist
- Before you say done, run diagnostics and fix errors you introduced.
- Read before you write: repo_map, search, read_file (only the lines you need).
- Keep layers apart: HTTP handlers, business logic, data access.
- Prefer the libraries the project already uses; add a dependency only with a clear reason.
- Use list_blocks for login, roles, audit log, rate limiting and pagination instead of writing security code from scratch.
- Check edge cases: empty, duplicate, too long, concurrent, time zones, money.
- After building pages: start_preview, then check_page at phone, tablet and desktop; fix console errors and critical or serious accessibility issues before you finish.

## Avoid
- Guessing file contents or APIs; read them or use read_playbook.
- Weakening or deleting tests to make them pass.
- Catch-all error handling that hides failures; string-built SQL; secrets in code.
- Big rewrites when a small, precise edit does the job.
