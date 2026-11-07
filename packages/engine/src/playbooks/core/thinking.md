## Definition of done
- options.md compares 2 or 3 real approaches. For each: architecture in two lines, stack, data model sketch, pros, cons, effort (S, M, L) and main risk.
- One clear recommendation with the reason, fitted to the user's constraints: local, Windows first, the stack they named, a small team.
- A "Missing requirements" list: questions the brief does not answer (who are the users, what happens on conflict, which data is private, what must be audited).
- A "Suggested features" list ranked by value and effort, taken from what production systems of this kind have: password reset, audit log, CSV export, notifications, search, soft delete, admin dashboard, rate limiting.

## Checklist
- Read brief.md first; reuse its user stories and personas.
- Name the core entities and their relations; spot the hard rules early (uniqueness, availability, money, permissions).
- Prefer boring, proven stacks: FastAPI or NestJS or Express, PostgreSQL, React or Next.js, unless the user chose otherwise.
- Say what the recommended approach makes hard later, and how to keep that door open.
- Point to building blocks (list_blocks) that cover auth, roles, audit and pagination.
- In an empty project, base the recommendation on the closest blueprint (list_blueprints) and name it.

## Avoid
- Straw-man options that exist only to lose.
- Cloud-only services, paid APIs or accounts the user did not ask for.
- Over-engineering an MVP: Kubernetes, microservices, event sourcing, GraphQL without a reason.
- Writing code or long essays; options.md should fit on two screens.
