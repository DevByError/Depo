---
title: OWASP Top 10 and API Security Top 10 with code fixes
summary: The common web and API risks, how to spot each in code, and the concrete fix.
agents: security, backend, reasoning, integration, frontend, coder
triggers: security, secure, owasp, vulnerability, vulnerabilities, injection, xss, csrf, ssrf, idor, audit, pentest, threat model, hardening
---
# OWASP Top 10 and API Security Top 10 with code fixes

Review route by route. For each finding write: severity, file:line, what an attacker can do, the fix, the owner.

## Broken access control (web A01; API1 object level, API5 function level)
Spot: handlers that load by id without an owner or tenant filter (`db.get(Booking, id)`), admin routes guarded only in the UI, permission checks missing on PUT/DELETE while present on GET.
Fix: deny by default; a permission dependency or guard on every route; queries scoped by owner (`where(Booking.id == id, Booking.user_id == user.id)`), returning 404 for others' records; tests per role.

## Broken object property level authorisation (API3) and mass assignment
Spot: `User(**request.json)`, `Object.assign(user, req.body)`, `fields = "__all__"`, response models returning the ORM object.
Fix: explicit request schemas with allowed fields only (users cannot set `role`, `is_admin`, `owner_id`, `price`); explicit response schemas without `password_hash`, tokens or internal flags; `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` in NestJS.

## Injection (web A03 in 2021)
Spot: f-strings or template literals in SQL, `$where` or raw objects in MongoDB filters, `shell=True` or `exec` with user input, `eval`, unsafe template rendering.
Fix: parameterised queries (`text("... where email = :e")`, `pool.query("... $1", [v])`), ORM query builders, validate types before building Mongo filters, `subprocess.run([...], shell=False)` with an allow-list, auto-escaping templates. XSS: never `dangerouslySetInnerHTML` or `v-html` with user content without a sanitiser (DOMPurify); set a Content-Security-Policy.

## Cryptographic failures
Spot: MD5 or SHA-1 for passwords, homemade crypto, secrets in code, HTTP for credentials, tokens from `Math.random()`.
Fix: Argon2id for passwords; `secrets.token_urlsafe(32)` or `crypto.randomBytes(32)` for tokens; TLS outside localhost; secrets from the environment; encrypt sensitive fields at rest when required.

## Authentication failures (API2)
Spot: no rate limit on login, user enumeration in messages, long-lived JWTs without revocation, JWT verified without algorithm pinning, password reset tokens that never expire.
Fix: see the auth playbook: generic messages, rate limits and lockout, short access tokens with rotating refresh tokens, pinned algorithms, single-use hashed reset tokens.

## Security misconfiguration (API8)
Spot: `DEBUG=True` or stack traces in responses, `allow_origins=["*"]` with credentials, default admin passwords, verbose server headers, open docs or admin panels in production without auth, permissive file permissions in Dockerfiles (running as root).
Fix: environment-specific config; explicit CORS origins; security headers (helmet, or a middleware setting `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `frame-ancestors 'none'`); non-root containers; seed admin passwords from the environment.

## Unrestricted resource consumption (API4) and business flows (API6)
Spot: no limit cap on list endpoints, unbounded uploads, no timeouts on outbound calls, expensive endpoints (export, AI, email) without rate limits, sign-up or booking flows that bots can spam.
Fix: `limit <= 100`, request body size limits, upload type and size checks, timeouts everywhere, rate limits per user and IP, CAPTCHA or email verification on abuse-prone flows, background jobs for heavy work.

## Vulnerable and outdated components (supply chain)
Spot: old lockfiles, abandoned packages, unpinned versions, packages installed from URLs.
Fix: run `npm audit`, `pip-audit`, OSV-Scanner (security_scan does this when installed), pin versions with lockfiles, remove unused dependencies, update with tests.

## Software and data integrity failures
Spot: deserialising untrusted data (`pickle.loads`, `yaml.load` without SafeLoader), unsigned webhooks, CI that runs untrusted code with secrets.
Fix: JSON with schema validation, `yaml.safe_load`, verify webhook signatures (HMAC with constant-time comparison), pin CI actions.

## Logging and monitoring failures
Spot: no logs for login failures or permission changes, or logs that contain passwords, tokens and full card numbers.
Fix: structured logs for security events with user id and request id; redact secrets (pino `redact`, logging filters); an audit table for admin actions.

## SSRF (API7) and unsafe consumption of APIs (API10)
Spot: the server fetches a URL from the request (webhooks, image import, link previews); trusting third-party API responses without validation.
Fix: allow-list hosts and schemes, block private and link-local ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1) after DNS resolution, disable redirects or re-check them, timeouts and size limits; validate third-party responses with schemas.

## Improper inventory management (API9) and exceptional conditions
Spot: old API versions still deployed, debug or test routes reachable, errors that fail open (an exception in the auth check lets the request through).
Fix: list every route in openapi.yaml and remove the rest; fail closed (any error in an auth or permission check means deny); catch errors at the boundary and return a generic 500 with a request id.

## Severity guide
High: auth bypass, access to other users' data, injection, secrets exposed, remote code execution. Medium: missing rate limits on login, weak session settings, verbose errors, missing security headers on authenticated pages. Low: hardening and defence in depth. High findings block the release.
