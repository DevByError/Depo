import type { Block } from "./types";

/**
 * Password hashing with scrypt (standard library only). Shared with the FastAPI blueprint, which
 * uses it as is, so there is one version of this code.
 */
export const PY_PASSWORDS = String.raw`MIN_PASSWORD_LENGTH = 8
_N, _R, _P = 16384, 8, 1


def hash_password(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError("The password must be at least %d characters long." % MIN_PASSWORD_LENGTH)
    salt = os.urandom(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=64)
    return "$".join(["scrypt", str(_N), str(_R), str(_P), base64.b64encode(salt).decode(), base64.b64encode(key).decode()])


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, key = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(key)
        actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)
`;

/** Signed, expiring tokens (HMAC-SHA256) with the standard library only. */
const PY_TOKENS = String.raw`def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _check_secret(secret: str) -> None:
    if len(secret) < 32:
        raise ValueError("The token secret must be at least 32 characters long.")


def sign_token(claims: dict, secret: str, ttl_seconds: int = 3600, now: float | None = None) -> str:
    _check_secret(secret)
    iat = int(time.time() if now is None else now)
    payload = {**claims, "iat": iat, "exp": iat + ttl_seconds}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    return body + "." + sig


def verify_token(token: str | None, secret: str, now: float | None = None) -> dict | None:
    """The payload when the signature is valid and the token has not expired, otherwise None."""
    _check_secret(secret)
    if not token or token.count(".") != 1:
        return None
    body, sig = token.split(".")
    expected = _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or "sub" not in payload or int(payload.get("exp", 0)) <= int(time.time() if now is None else now):
        return None
    return payload
`;

export const AUTH_PY: Block = {
  id: "auth-py",
  name: "Login and sessions (Python)",
  description:
    "Password hashing with scrypt and signed expiring tokens using only the Python standard library. Plug it into FastAPI, Flask or Django.",
  stack: "py",
  tags: ["auth", "login", "security", "sessions", "python", "fastapi"],
  test: "python -m unittest discover -s tests -p test_auth.py",
  notes: [
    "Store password_hash in the users table; never store the password.",
    "Read the secret from an environment variable (at least 32 characters).",
    "In FastAPI, write a dependency that calls verify_token(header_value, SECRET) and raises 401 when it returns None.",
    "Add the rbac-py block to decide what each role may do.",
  ],
  files: [
    { path: "app/__init__.py", content: "" },
    {
      path: "app/auth.py",
      content: `"""Passwords and signed tokens with the standard library only."""
import base64
import hashlib
import hmac
import json
import os
import time

${PY_PASSWORDS}

${PY_TOKENS}`,
    },
    {
      path: "tests/test_auth.py",
      content: String.raw`import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.auth import hash_password, sign_token, verify_password, verify_token  # noqa: E402

SECRET = "x" * 40


class PasswordTests(unittest.TestCase):
    def test_hash_and_verify(self):
        h = hash_password("correct horse battery")
        self.assertTrue(h.startswith("scrypt$"))
        self.assertNotIn("correct horse", h)
        self.assertTrue(verify_password("correct horse battery", h))
        self.assertFalse(verify_password("wrong password", h))
        self.assertFalse(verify_password("anything", "garbage"))
        self.assertNotEqual(h, hash_password("correct horse battery"))

    def test_short_password_is_refused(self):
        with self.assertRaises(ValueError):
            hash_password("short")


class TokenTests(unittest.TestCase):
    def test_valid_expired_and_wrong_secret(self):
        t = sign_token({"sub": "u1", "role": "admin"}, SECRET, 60, now=1_000_000)
        self.assertEqual(verify_token(t, SECRET, now=1_000_000)["sub"], "u1")
        self.assertIsNone(verify_token(t, SECRET, now=1_000_061))
        self.assertIsNone(verify_token(t, "y" * 40, now=1_000_000))

    def test_tampering_and_junk(self):
        t = sign_token({"sub": "u1", "role": "user"}, SECRET, 60, now=1_000_000)
        body, sig = t.split(".")
        self.assertIsNone(verify_token(body + "x." + sig, SECRET, now=1_000_000))
        self.assertIsNone(verify_token("nope", SECRET))
        self.assertIsNone(verify_token(None, SECRET))
        with self.assertRaises(ValueError):
            sign_token({"sub": "u"}, "short")


if __name__ == "__main__":
    unittest.main()
`,
    },
  ],
};

export const RBAC_PY: Block = {
  id: "rbac-py",
  name: "Roles and permissions (Python)",
  description:
    "A role-based access policy: roles list permissions such as 'posts:write', can inherit from other roles, and support wildcards. Deny by default.",
  stack: "py",
  tags: ["roles", "permissions", "authorization", "security", "python"],
  test: "python -m unittest discover -s tests -p test_rbac.py",
  notes: [
    "Define one Policy for the whole system and check it on the server for every route.",
    "Check the permission, not the role name: policy.can(user.role, 'invoices:delete').",
    "In FastAPI, wrap it in a dependency that raises HTTPException(403).",
  ],
  files: [
    { path: "app/__init__.py", content: "" },
    {
      path: "app/rbac.py",
      content: String.raw`"""Role-based access control. Deny by default."""


class ForbiddenError(Exception):
    pass


def _matches(granted: str, wanted: str) -> bool:
    if granted in ("*", wanted):
        return True
    return granted.endswith(":*") and wanted.startswith(granted[:-1])


class Policy:
    def __init__(self, roles: dict, inherits: dict | None = None):
        self._roles = {k: list(v) for k, v in roles.items()}
        self._inherits = {k: list(v) for k, v in (inherits or {}).items()}
        self._cache: dict = {}
        for role in self._roles:  # fail at start-up, not on the first request
            self.permissions_of(role)

    def permissions_of(self, role: str, _seen: tuple = ()) -> set:
        if role in self._cache:
            return self._cache[role]
        if role in _seen:
            raise ValueError("Roles inherit from each other in a loop: " + " -> ".join(_seen + (role,)))
        out = set(self._roles.get(role, []))
        for parent in self._inherits.get(role, []):
            out |= self.permissions_of(parent, _seen + (role,))
        self._cache[role] = out
        return out

    def can(self, role, permission: str) -> bool:
        if not role or role not in self._roles:
            return False
        return any(_matches(g, permission) for g in self.permissions_of(role))

    def assert_can(self, role, permission: str) -> None:
        if not self.can(role, permission):
            raise ForbiddenError("You are not allowed to do this (%s)." % permission)
`,
    },
    {
      path: "tests/test_rbac.py",
      content: String.raw`import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.rbac import ForbiddenError, Policy  # noqa: E402

policy = Policy(
    {"viewer": ["posts:read"], "editor": ["posts:write", "comments:*"], "admin": ["users:*"], "root": ["*"]},
    {"editor": ["viewer"], "admin": ["editor"]},
)


class PolicyTests(unittest.TestCase):
    def test_inheritance(self):
        self.assertTrue(policy.can("viewer", "posts:read"))
        self.assertFalse(policy.can("viewer", "posts:write"))
        self.assertTrue(policy.can("editor", "posts:read"))
        self.assertTrue(policy.can("admin", "posts:write"))

    def test_wildcards(self):
        self.assertTrue(policy.can("editor", "comments:delete"))
        self.assertFalse(policy.can("editor", "commentsX:delete"))
        self.assertTrue(policy.can("root", "anything:at-all"))

    def test_deny_by_default(self):
        self.assertFalse(policy.can("hacker", "posts:read"))
        self.assertFalse(policy.can(None, "posts:read"))
        self.assertFalse(policy.can("viewer", "billing:read"))

    def test_assert_and_loops(self):
        with self.assertRaises(ForbiddenError):
            policy.assert_can("viewer", "posts:write")
        policy.assert_can("editor", "posts:write")
        with self.assertRaises(ValueError):
            Policy({"a": [], "b": []}, {"a": ["b"], "b": ["a"]})


if __name__ == "__main__":
    unittest.main()
`,
    },
  ],
};

export const LOGIN_REACT: Block = {
  id: "login-form-react",
  name: "Accessible login form (React)",
  description:
    "A login form with labels, inline validation, an error region screen readers announce, a disabled state while sending, and a show-password toggle. The validation is plain TypeScript and tested.",
  stack: "react",
  tags: ["auth", "login", "form", "accessibility", "react"],
  test: "bun test src/components/login-validate.test.ts",
  notes: [
    "Pass onSubmit(email, password) and throw an Error with a user-friendly message when it fails.",
    "Style it with your design tokens; the markup already uses labels, aria-invalid and role=alert.",
    "Do the real check on the server; this validation only saves a round trip.",
  ],
  files: [
    {
      path: "src/components/login-validate.ts",
      content: String.raw`export interface LoginErrors {
  email?: string;
  password?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLogin(email: string, password: string): LoginErrors {
  const errors: LoginErrors = {};
  if (!email.trim()) errors.email = "Enter your email address.";
  else if (!EMAIL.test(email.trim())) errors.email = "Enter a valid email address, like name@example.com.";
  if (!password) errors.password = "Enter your password.";
  return errors;
}
`,
    },
    {
      path: "src/components/login-validate.test.ts",
      content: String.raw`import { expect, test } from "bun:test";
import { validateLogin } from "./login-validate";

test("empty fields explain what to do", () => {
  expect(validateLogin("", "")).toEqual({ email: "Enter your email address.", password: "Enter your password." });
});

test("a malformed email is explained and a good one passes", () => {
  expect(validateLogin("nope", "x").email).toContain("valid email");
  expect(validateLogin(" a@b.co ", "x")).toEqual({});
});
`,
    },
    {
      path: "src/components/LoginForm.tsx",
      content: String.raw`import { type FormEvent, useId, useState } from "react";
import { validateLogin } from "./login-validate";

export interface LoginFormProps {
  onSubmit(email: string, password: string): Promise<void>;
}

export function LoginForm({ onSubmit }: LoginFormProps) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<ReturnType<typeof validateLogin>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateLogin(email, password);
    setErrors(found);
    setFormError("");
    if (found.email || found.password) return;
    setBusy(true);
    try {
      await onSubmit(email.trim(), password);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby={id + "-title"}>
      <h1 id={id + "-title"}>Sign in</h1>
      <div role="alert" aria-live="assertive">
        {formError}
      </div>
      <label htmlFor={id + "-email"}>Email</label>
      <input
        id={id + "-email"}
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-invalid={errors.email ? true : undefined}
        aria-describedby={errors.email ? id + "-email-error" : undefined}
      />
      {errors.email && <p id={id + "-email-error"}>{errors.email}</p>}
      <label htmlFor={id + "-password"}>Password</label>
      <input
        id={id + "-password"}
        type={show ? "text" : "password"}
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={errors.password ? true : undefined}
        aria-describedby={errors.password ? id + "-password-error" : undefined}
      />
      {errors.password && <p id={id + "-password-error"}>{errors.password}</p>}
      <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}>
        {show ? "Hide password" : "Show password"}
      </button>
      <button type="submit" disabled={busy}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
`,
    },
  ],
};

export const COMPOSE_PG: Block = {
  id: "compose-postgres",
  name: "PostgreSQL for local development (Docker)",
  description:
    "A docker-compose file that starts PostgreSQL with a health check and a named volume, reading its password from .env. Needs Docker; nothing is started for you.",
  stack: "docker",
  tags: ["database", "postgres", "docker", "devops"],
  test: "",
  notes: [
    "Copy .env.example to .env and choose a real password.",
    "Start it with: docker compose up -d db",
    "Connection string: postgresql://app:<password>@localhost:5432/app",
    "The port is bound to 127.0.0.1 only, so other machines cannot reach it.",
  ],
  files: [
    {
      path: "docker-compose.yml",
      content: String.raw`services:
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${"$"}{POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: app
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - dbdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  dbdata:
`,
    },
    { path: ".env.example", content: "POSTGRES_PASSWORD=change-me-before-first-start\n" },
  ],
};
