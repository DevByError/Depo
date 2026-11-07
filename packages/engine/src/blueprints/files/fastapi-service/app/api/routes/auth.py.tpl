"""Sign up, sign in and "who am I". HTTP only: the rules are in app/services/auth.py."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from app.api.deps import get_conn, get_current_user, get_settings
from app.core.config import Settings
from app.db.database import Connection
from app.schemas.users import LoginIn, SignUpIn, TokenOut, UserOut
from app.services.auth import AuthService

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/signup", response_model=TokenOut, status_code=201)
def sign_up(
    data: SignUpIn,
    conn: Connection = Depends(get_conn),
    settings: Settings = Depends(get_settings),
) -> TokenOut:
    return AuthService(conn, settings).sign_up(data)


@router.post("/login", response_model=TokenOut)
def log_in(
    data: LoginIn,
    request: Request,
    conn: Connection = Depends(get_conn),
    settings: Settings = Depends(get_settings),
) -> TokenOut:
    client = request.client.host if request.client else "unknown"
    return AuthService(conn, settings, request.app.state.login_limiter).log_in(data, client)


@router.get("/me", response_model=UserOut)
def me(user: dict[str, Any] = Depends(get_current_user)) -> UserOut:
    return UserOut(**user)
