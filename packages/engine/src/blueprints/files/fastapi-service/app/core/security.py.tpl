"""Access tokens (JWT) and who may do what (roles and permissions)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt

from app.core.rbac import Policy

ROLES = ("user", "admin")

# Deny by default: a role may do only what is listed here (admin inherits everything a user may do).
# Check permissions, not role names: Depends(require("projects:delete")), POLICY.can(role, "users:read").
POLICY = Policy(
    {
        "user": ["projects:create", "projects:read", "projects:update", "projects:delete"],
        "admin": ["users:read", "users:update", "projects:any"],
    },
    {"admin": ["user"]},
)


def create_access_token(user_id: int, role: str, secret: str, minutes: int, algorithm: str = "HS256") -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "role": role, "iat": now, "exp": now + timedelta(minutes=minutes)}
    return jwt.encode(payload, secret, algorithm=algorithm)


def decode_access_token(token: str, secret: str, algorithm: str = "HS256") -> int | None:
    """The user id when the token is valid and has not expired, otherwise None."""
    try:
        payload = jwt.decode(token, secret, algorithms=[algorithm], options={"require": ["exp", "sub"]})
        return int(payload["sub"])
    except (jwt.PyJWTError, ValueError, TypeError, KeyError):
        return None
