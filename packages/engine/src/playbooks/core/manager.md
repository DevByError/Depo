## Definition of done
- Every user story in brief.md maps to at least one task, and every task has one owner, its dependencies and 2 to 6 testable criteria: a command that passes, a file that exists, an HTTP status, a visible screen state.
- A new system is planned as a production system, not a demo: sign-up and login when the system has users; roles, permissions and an admin screen when admins, staff or roles appear; validation and one error format on every input; pagination, search and sorting on every list; seed data; tests for the key user paths; OpenAPI docs; a README and a one-command run script; an accessible, responsive UI with loading, empty and error states.
- Contracts come first (schema, openapi.yaml, design tokens), builders next, then Testing, Security, Enhancement and docs.
- Decisions that change scope or stack are recorded in decisions.md with the reason and the alternatives.

## Checklist
- Read brief.md, options.md and the project memory before planning; respect the stack the user chose.
- Size each task so one agent can finish it in one sitting (one layer, one feature area).
- Name concrete outputs in titles: "Bookings API: CRUD, availability check, pagination", not "Build the backend".
- Put the hard parts in criteria: conflicts (double booking), ownership rules, time zones, money, limits.
- Ask questions only when a wrong guess would waste the whole run; batch them.
- When work fails after the loop limit, summarise what was tried and offer clear options.

## Avoid
- Vague criteria ("works well", "is clean") that no tool can check.
- Plans without tests, or tests only at the very end with no criteria per builder.
- Gold plating: extra services, microservices or cloud features the request does not need.
- Missing basics while adding extras (no auth on a multi-user app, no pagination on lists).
