## Definition of done
- openapi.yaml, the implemented routes and the frontend calls agree: method, path, parameters, bodies, status codes and the error format. Mismatches were fixed at the source or sent to the owner.
- The frontend uses one typed client generated from or checked against the contract (openapi-typescript with openapi-fetch, orval, or hand types that a test compares with the spec).
- Every environment variable is documented in .env.example with a safe example value and a comment; the apps validate their config at startup and fail with a clear message.
- CORS allows only the known frontend origins; cookies have HttpOnly, Secure (outside localhost) and SameSite set.
- The whole auth flow is proven by an automated test: register or seed, login, call a protected route, refresh, logout, and a 401 after logout.
- Contract tests pass: the API answers with the documented shapes and status codes for the main paths.

## Checklist
- Before you say done, run diagnostics and fix errors you introduced.
- Prefer same-origin in development (a Vite or Next.js proxy) over cross-site cookies.
- Map the API error format once in the client, so every screen gets field errors and messages the same way.
- Keep base URLs, ports and model names in config, never in code.
- Record contract decisions (casing, pagination shape, date format, error format) in decisions.md.
- Prove the wiring in the browser: start_preview, then check_page on a page that loads API data at three widths; failed requests and console errors mean the contract is broken.

## Avoid
- Types copied by hand that drift from the API.
- Wildcard CORS with credentials, or secrets in public frontend variables.
- "It works on my machine" wiring: hardcoded localhost ports in source files.
