"""The example resource with full CRUD. Copy this file (and its schema, repository, service and
tests) for each new resource, then register the router in app/main.py."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Path, Query, Response

from app.api.deps import get_conn, require
from app.db.database import Connection
from app.schemas.common import MAX_PAGE_SIZE, Page
from app.schemas.projects import ProjectIn, ProjectOut, ProjectUpdate, Sort, Status
from app.services.projects import ProjectService

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=Page[ProjectOut])
def list_projects(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=MAX_PAGE_SIZE),
    status: Status | None = Query(None),
    q: str | None = Query(None, max_length=100, description="Part of the name"),
    sort: Sort = Query("-created_at"),
    user: dict[str, Any] = Depends(require("projects:read")),
    conn: Connection = Depends(get_conn),
) -> Page[ProjectOut]:
    return ProjectService(conn, user).list(status=status, q=q, sort=sort, page=page, page_size=page_size)


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    data: ProjectIn,
    user: dict[str, Any] = Depends(require("projects:create")),
    conn: Connection = Depends(get_conn),
) -> ProjectOut:
    return ProjectService(conn, user).create(data)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: int = Path(ge=1),
    user: dict[str, Any] = Depends(require("projects:read")),
    conn: Connection = Depends(get_conn),
) -> ProjectOut:
    return ProjectService(conn, user).get(project_id)


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    data: ProjectUpdate,
    project_id: int = Path(ge=1),
    user: dict[str, Any] = Depends(require("projects:update")),
    conn: Connection = Depends(get_conn),
) -> ProjectOut:
    return ProjectService(conn, user).update(project_id, data)


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: int = Path(ge=1),
    user: dict[str, Any] = Depends(require("projects:delete")),
    conn: Connection = Depends(get_conn),
) -> Response:
    ProjectService(conn, user).delete(project_id)
    return Response(status_code=204)
