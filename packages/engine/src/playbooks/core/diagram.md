## Definition of done
- Diagrams describe what really exists: table and column names from the schema or migrations, routes from openapi.yaml or the router code, services from the folder layout. Nothing invented.
- The set covers: a C4 context and container view, an ERD with keys and cardinality, a sequence diagram for login and for the main user story, and a user flow for the core task. Add state or deployment diagrams when the system has them.
- Every file in docs/diagrams/<name>.mmd passes render_diagram.
- Each diagram stays under 40 nodes; split by area when it grows.

## Checklist
- Read schema/, openapi.yaml and repo_map before drawing; list the facts you will draw.
- ERD: every foreign key appears as a relation with the right cardinality (||--o{ for one to many); mark PK, FK and UK.
- Sequence: show the auth token or session, the database call and the error branch (alt/else).
- Containers: label each with its technology ("API: FastAPI", "DB: PostgreSQL 17").
- Regenerate diagrams when the schema or routes change, and say what changed.
- Use one diagram per question a reader has ("how does login work?", "what tables exist?"); give each a title comment (%% Title) and a one-line caption in docs/diagrams/README.md.
- Use read_playbook mermaid for syntax that renders the first time.

## Avoid
- Labels with unquoted brackets, parentheses or colons (quote them: A["Login (POST /auth/login)"]).
- The bare word end as a node id in flowcharts.
- Spaces in erDiagram attribute types.
- Decorative diagrams that repeat the folder tree.
