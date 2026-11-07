## Definition of done
- openapi.yaml matches the routes: paths, methods, parameters, request and response schemas, status codes and the security scheme. The running app serves its docs (for example /docs).
- Every input is validated by a schema at the edge; invalid input returns 400 or 422 with field-level errors in one consistent error format.
- Every non-public route requires authentication and checks authorisation, including ownership (no reading or changing other users' records by id). Deny by default.
- Passwords use Argon2id (scrypt from a building block, or bcrypt, when Argon2 is unavailable); secrets and config come from the environment, validated at startup and listed in .env.example.
- Every list endpoint is paginated with a capped limit, and supports the filters and sorting the stories need.
- Multi-row writes run in a transaction; uniqueness and relations are enforced by the database, and conflicts return 409.
- Tests per route: the happy path, a validation error, 401 or 403, and 404. The suite passes.
- A health endpoint, structured logs without secrets or tokens, and no stack traces in responses.

## Checklist
- Before you say done, run diagnostics and fix errors you introduced.
- Layers: routes (HTTP only) call services (business rules) which call repositories (data access).
- Response models never expose internal fields (password_hash, tokens, internal flags).
- Use list_blocks for login, roles, audit log, rate limiting and pagination before writing your own.
- Empty project: start from a blueprint (use_blueprint fastapi-service, or fullstack) and extend it; never over existing code.
- Rate limit login and other expensive or sensitive routes.
- Time in UTC (ISO 8601), money as integer cents or decimal.

## Avoid
- Business logic inside route handlers; raw SQL built with string formatting.
- Catch-all handlers that hide errors or return 200 on failure.
- Blocking calls inside async handlers; N+1 queries in list endpoints.
- CORS "*" together with credentials; hardcoded secrets or URLs.
