"""Sign-up, sign-in and the admin's user management. The rules live here, not in the routes."""

from __future__ import annotations

from typing import Any

from app.core.config import Settings
from app.core.errors import Conflict, NotFound, TooManyRequests, Unauthorized
from app.core.passwords import hash_password, verify_password
from app.core.rate_limit import RateLimiter
from app.core.security import create_access_token
from app.db.database import Connection, IntegrityError
from app.repositories.users import UserRepository
from app.schemas.common import Page
from app.schemas.users import LoginIn, SignUpIn, TokenOut, UserOut

_DUMMY_HASH: list[str] = []


def _dummy_hash() -> str:
    # Checked when the email is unknown, so a wrong email takes as long as a wrong password.
    if not _DUMMY_HASH:
        _DUMMY_HASH.append(hash_password("not-a-real-password-0"))
    return _DUMMY_HASH[0]


class AuthService:
    def __init__(self, conn: Connection, settings: Settings, limiter: RateLimiter | None = None):
        self.users = UserRepository(conn)
        self.settings = settings
        self.limiter = limiter

    def token_for(self, user: dict[str, Any]) -> TokenOut:
        s = self.settings
        token = create_access_token(user["id"], user["role"], s.jwt_secret, s.token_minutes, s.jwt_algorithm)
        return TokenOut(access_token=token, expires_in=s.token_minutes * 60, user=UserOut(**user))

    def sign_up(self, data: SignUpIn) -> TokenOut:
        if self.users.credentials(data.email):
            raise Conflict("An account with this email already exists. Sign in instead.")
        try:
            user = self.users.create(data.email, data.name, hash_password(data.password))
        except IntegrityError as exc:  # two sign-ups at the same moment
            raise Conflict("An account with this email already exists. Sign in instead.") from exc
        return self.token_for(user)

    def log_in(self, data: LoginIn, client: str) -> TokenOut:
        key = f"{data.email}|{client}"
        if self.limiter and (wait := self.limiter.retry_after(key)):
            raise TooManyRequests(f"Too many failed sign-ins. Try again in {wait} seconds.")
        found = self.users.credentials(data.email)
        ok = verify_password(data.password, found["password_hash"] if found else _dummy_hash())
        if not found or not ok:
            if self.limiter:
                self.limiter.fail(key)
            raise Unauthorized("Wrong email or password.")
        if self.limiter:
            self.limiter.reset(key)
        user = {k: v for k, v in found.items() if k != "password_hash"}
        return self.token_for(user)

    # ---- admin -------------------------------------------------------------------------

    def list_users(self, q: str | None, page: int, page_size: int) -> Page[UserOut]:
        rows, total = self.users.list(q=q, limit=page_size, offset=(page - 1) * page_size)
        return Page[UserOut].of([UserOut(**r) for r in rows], total, page, page_size)

    def set_role(self, user_id: int, role: str) -> UserOut:
        user = self.users.get(user_id)
        if not user:
            raise NotFound("This user does not exist.")
        if user["role"] == "admin" and role != "admin" and self.users.count_admins() <= 1:
            raise Conflict("Keep at least one admin.")
        updated = self.users.set_role(user_id, role)
        assert updated is not None
        return UserOut(**updated)
