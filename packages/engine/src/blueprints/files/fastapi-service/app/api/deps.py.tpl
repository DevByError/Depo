"""Dependencies the routes share: settings, a database session, the signed-in user, permissions."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings
from app.core.errors import Forbidden, Unauthorized
from app.core.security import POLICY, decode_access_token
from app.db.database import Connection
from app.repositories.users import UserRepository

bearer = HTTPBearer(auto_error=False, description="The access_token from /api/auth/login")


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_conn(request: Request) -> Iterator[Connection]:
    """One connection per request: committed when the request succeeds, rolled back otherwise."""
    with request.app.state.db.session() as conn:
        yield conn


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    conn: Connection = Depends(get_conn),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    if creds is None:
        raise Unauthorized("Sign in first.")
    user_id = decode_access_token(creds.credentials, settings.jwt_secret, settings.jwt_algorithm)
    # The role comes from the database, not the token, so a role change applies at once.
    user = UserRepository(conn).get(user_id) if user_id is not None else None
    if user is None:
        raise Unauthorized("Your session has ended. Sign in again.")
    return user


def require(permission: str) -> Callable[..., dict[str, Any]]:
    """A dependency that lets the request through only when the user's role has `permission`."""

    def check(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
        if not POLICY.can(user["role"], permission):
            raise Forbidden("You do not have permission to do this.")
        return user

    return check
