"""User management for admins. Every route checks a permission."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_conn, get_settings, require
from app.core.config import Settings
from app.db.database import Connection
from app.schemas.common import MAX_PAGE_SIZE, Page
from app.schemas.users import RoleUpdate, UserOut
from app.services.auth import AuthService

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=Page[UserOut])
def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=MAX_PAGE_SIZE),
    q: str | None = Query(None, max_length=100, description="Part of an email or name"),
    _: dict[str, Any] = Depends(require("users:read")),
    conn: Connection = Depends(get_conn),
    settings: Settings = Depends(get_settings),
) -> Page[UserOut]:
    return AuthService(conn, settings).list_users(q, page, page_size)


@router.patch("/{user_id}/role", response_model=UserOut)
def change_role(
    data: RoleUpdate,
    user_id: int = Path(ge=1),
    _: dict[str, Any] = Depends(require("users:update")),
    conn: Connection = Depends(get_conn),
    settings: Settings = Depends(get_settings),
) -> UserOut:
    return AuthService(conn, settings).set_role(user_id, data.role)
