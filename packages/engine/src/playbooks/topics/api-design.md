---
title: REST API design and OpenAPI 3.1
summary: Resource naming, status codes, one error format, pagination, filtering, idempotency, OpenAPI-first contracts.
agents: backend, integration, frontend, reasoning, testing, diagram, coder
triggers: api, rest, restful, openapi, swagger, endpoint, endpoints, route, routes, http
---
# REST API design and OpenAPI 3.1

## Resources and methods
- Plural nouns, lower-case, hyphenated: `/api/v1/bookings`, `/api/v1/bookings/{bookingId}`, nested only one level when ownership is strict: `/api/v1/clinics/{clinicId}/doctors`.
- Actions that are not CRUD become sub-resources or verbs on a resource: `POST /bookings/{id}/cancel`.
- `GET` reads (safe, cacheable), `POST` creates (201 + `Location` header + body), `PUT` replaces, `PATCH` partially updates (only sent fields change), `DELETE` removes (204).

## Status codes that matter
| Code | Use |
|---|---|
| 200 / 201 / 204 | OK, created, no content |
| 400 | Malformed request (bad JSON, wrong type when the framework does not use 422) |
| 401 | Not authenticated (missing or invalid token); send `WWW-Authenticate` for bearer auth |
| 403 | Authenticated but not allowed |
| 404 | Not found, and also for records the caller may not know exist (avoid leaking ids) |
| 409 | Conflict with current state: duplicate email, overlapping booking, stale version |
| 422 | Validation failed (FastAPI default) |
| 429 | Rate limited; send `Retry-After` |
| 500 | Unexpected; log it with a request id, never return the stack trace |

## One error format
Use RFC 9457 problem details (`application/problem+json`) or a simple envelope, but only one, everywhere:

```json
{
  "type": "https://example.com/problems/validation",
  "title": "Invalid request",
  "status": 422,
  "detail": "2 fields are invalid.",
  "errors": [{ "field": "email", "message": "Enter a valid email address." }],
  "requestId": "req_7f3a"
}
```
Map framework errors (validation, not found, integrity errors) to it in one place (an exception handler or error middleware), so clients can show field errors generically.

## Pagination, filtering, sorting
- Offset style: `?limit=20&offset=40` returning `{ "items": [...], "total": 312, "limit": 20, "offset": 40 }`. Cap `limit` (for example 100) and default it (20).
- Cursor style for large or fast-changing tables: `?limit=20&cursor=<opaque>` returning `{ "items": [...], "nextCursor": "..." }`, implemented as keyset (`WHERE (created_at, id) < (...) ORDER BY created_at DESC, id DESC`).
- Filters as explicit query parameters (`?status=confirmed&doctorId=7&from=2026-01-01`), validated and allow-listed. Sorting with an allow-list: `?sort=-createdAt,name`.
- Always a stable order (add the id as a tie-breaker).

## Other rules
- Dates as ISO 8601 in UTC (`2026-03-01T09:30:00Z`); durations in seconds or ISO 8601.
- One casing for JSON fields across the API (camelCase or snake_case) and record it in decisions.md.
- Never expose internal fields (password hashes, tokens, internal flags); response schemas are separate from database models.
- Idempotency for retried creates that must not duplicate (payments, orders): accept an `Idempotency-Key` header and store the result per key.
- Optimistic concurrency for edits that can collide: return an `ETag` or `version`, require `If-Match` or the version on update, answer 409 or 412 when stale.
- Version in the path (`/api/v1`) and never break a published contract; add fields instead.
- Health: `GET /health` (process up) and optionally `GET /ready` (database reachable).

## OpenAPI 3.1 first
Write or update `openapi.yaml` before coding routes, then keep it in sync (frameworks like FastAPI, NestJS with @nestjs/swagger and Fastify with @fastify/swagger generate it; export and compare).

```yaml
openapi: 3.1.0
info: { title: Clinic API, version: 1.0.0 }
paths:
  /api/v1/bookings:
    get:
      operationId: listBookings
      security: [{ bearerAuth: [] }]
      parameters:
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
        - { name: offset, in: query, schema: { type: integer, minimum: 0, default: 0 } }
      responses:
        "200": { description: Page of bookings, content: { application/json: { schema: { $ref: "#/components/schemas/BookingPage" } } } }
        "401": { $ref: "#/components/responses/Problem" }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
```
Give every operation an `operationId` (typed clients use it), reuse schemas through `components`, and document every error status the route can return.
