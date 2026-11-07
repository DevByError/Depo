---
title: Authentication done right
summary: Argon2id hashing, login hardening, JWT access plus rotating refresh tokens, server sessions, cookies and CSRF, password reset, OAuth with PKCE, 2FA.
agents: backend, security, integration, frontend, testing, coder
triggers: auth, authentication, login, log in, sign in, signin, sign up, signup, register, registration, password, jwt, token, tokens, session, sessions, oauth, sso, 2fa, mfa, users, accounts, account
---
# Authentication done right

Use the building blocks (`list_blocks`: auth-ts, auth-py, login-form-react, rate-limit-ts) or a mature library when they fit, and adapt them to the rules below. The blocks hash with scrypt from the standard library (no native dependency), which is acceptable; switch to Argon2id when the project can add the argon2 package.

## Password hashing
Argon2id with at least the OWASP minimum (memory 19 MiB, iterations 2, parallelism 1); library defaults are usually stronger.
```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
ph = PasswordHasher()                       # argon2-cffi, Argon2id by default
hash_ = ph.hash(password)
try:
    ph.verify(hash_, password)
    if ph.check_needs_rehash(hash_): user.password_hash = ph.hash(password)
except VerifyMismatchError:
    ...
```
```ts
import argon2 from "argon2";                 // npm "argon2"
const hash = await argon2.hash(password, { type: argon2.argon2id });
const ok = await argon2.verify(hash, password);
```
FastAPI docs use `pwdlib[argon2]`; Django has `Argon2PasswordHasher`. Use bcrypt (cost 12+) only when Argon2 is unavailable; never MD5, SHA-x or unsalted hashes.

Password policy (NIST style): at least 8 characters (12+ recommended), allow at least 64, allow spaces and paste, no forced composition rules or periodic resets; optionally block common or breached passwords.

## Login hardening
- One generic message for unknown email and wrong password: "Email or password is incorrect."
- Same timing for both: verify against a dummy hash when the user does not exist.
- Rate limit by IP and by account (for example 5 attempts per 5 minutes per account), then a growing delay or temporary lockout; answer 429 with Retry-After.
- Normalise emails (trim, lower-case) on sign-up and login.
- Log security events (login success, failure, lockout, password change) without passwords or tokens.

## Tokens: access plus rotating refresh
- Access token: JWT, 5 to 15 minutes, claims `sub`, `exp`, `iat`, `iss`, `aud`, optionally `roles`. Verify signature, `exp`, `iss`, `aud`, and pin the algorithm list (`algorithms=["HS256"]`); never accept `alg: none`. HS256 needs a random secret of 32+ bytes from the environment; asymmetric (EdDSA, RS256) when other services verify tokens.
- Refresh token: random 32+ bytes (not a JWT), stored **hashed** in a `refresh_tokens` table (`id, user_id, family_id, token_hash, expires_at, revoked_at, replaced_by`), 7 to 30 days.
- Rotation: each refresh returns a new refresh token and revokes the old one. If a revoked token is used again, revoke the whole family (someone stole it) and force sign-in.
- Logout revokes the refresh token; password change revokes all of the user's tokens.
- Delivery for browsers: refresh token in an `HttpOnly; Secure; SameSite=Lax` (or Strict) cookie scoped to `Path=/api/v1/auth`; access token in memory (not localStorage) or in its own HttpOnly cookie. Mobile apps keep the refresh token in the OS secure storage.

```python
@router.post("/auth/refresh")
def refresh(response: Response, db: DbSession, refresh_token: Annotated[str | None, Cookie()] = None):
    record = tokens.find_by_hash(db, sha256(refresh_token or ""))
    if not record or record.expires_at < now():
        raise AppError(401, "Please sign in again.")
    if record.revoked_at:                       # reuse detected
        tokens.revoke_family(db, record.family_id)
        raise AppError(401, "Please sign in again.")
    new_plain, new_record = tokens.rotate(db, record)   # revoke old, insert new in one transaction
    response.set_cookie("refresh_token", new_plain, httponly=True, secure=settings.cookie_secure,
                        samesite="lax", path="/api/v1/auth", max_age=30 * 86400)
    return {"access_token": issue_access_token(record.user_id), "token_type": "bearer"}
```

## Server sessions (simpler for same-site web apps)
Random session id (32 bytes) in an HttpOnly, Secure, SameSite cookie; session data on the server (database or Redis). Regenerate the id at login (prevents fixation), idle timeout (for example 30 minutes) and absolute timeout (for example 12 hours), delete on logout.

## CSRF
Needed whenever the browser sends credentials automatically (cookies). Use SameSite=Lax or Strict cookies **and** one of: a CSRF token (synchronizer or double-submit cookie sent back in a header like `X-CSRF-Token`), or a strict check of the `Origin` header on state-changing requests. Bearer tokens in the Authorization header are not sent automatically, so they do not need CSRF tokens. Never change state with GET.

## Password reset and email verification
Random single-use token (32 bytes), stored hashed with an expiry (15 to 60 minutes), sent by email as a link; the request endpoint always answers "If an account exists, we sent an email" (no account enumeration); on success, set the new password, revoke the token and all sessions. Locally, send email to a catcher such as Mailpit in docker compose.

## OAuth and sign-in with Google, GitHub or Microsoft
Authorization Code flow with PKCE and a `state` parameter; exact redirect URI allow-list; verify the ID token (issuer, audience, expiry, nonce) with a library (Authlib for Python, openid-client or Auth.js for Node). Link accounts by verified email only.

## Two-factor
TOTP (pyotp, otplib) with a QR code at enrolment, confirmation with a first code, one-time recovery codes stored hashed, rate-limited verification.

## Tests to write
Register then login; wrong password gives 401 and the generic message; too many attempts give 429; protected route without token gives 401; expired access token gives 401; refresh rotates and the old token is rejected; reusing an old refresh token revokes the family; logout invalidates; reset token works once and expires.
