## Definition of done
- security_scan was run and its findings triaged (true problem, false positive with the reason, or accepted risk).
- reviews/security.md has a short threat model (assets, entry points, trust boundaries, who the attackers are) and every finding with severity, file and line, the concrete fix and the owner agent.
- Access control was checked route by route: authentication on every non-public route, function-level checks for admin actions, object-level checks for every record fetched by id.
- No secrets in the repository, logs, error messages or public frontend variables; .env is git-ignored and .env.example has placeholders only.
- High severity findings are blocking and were routed to their owners.

## Checklist
- Authentication: Argon2id or bcrypt, generic login errors, rate limit and lockout on login, short-lived access tokens with refresh rotation or server sessions with rotation on login, logout that really invalidates.
- Input: schema validation at the edge, parameterised queries, output encoding in templates, no eval, safe file paths.
- Mass assignment: request models list allowed fields; users cannot set role, owner or price.
- Cookies: HttpOnly, Secure, SameSite; CSRF protection for cookie-authenticated state changes; CORS with explicit origins.
- Resource limits: pagination caps, request size limits, upload type and size checks, timeouts, rate limits.
- Headers: Content-Security-Policy, X-Content-Type-Options, frame-ancestors or X-Frame-Options, HSTS when served over HTTPS.
- Dependencies: audit (npm audit, pip-audit, OSV); pin versions; remove unused packages.
- Server-side requests to user-supplied URLs are allow-listed (SSRF).

## Avoid
- Generic advice without a file and line; theoretical issues marked blocking.
- Security through obscurity (hidden routes, client-only checks).
- Editing code yourself; route each fix to its owner.
