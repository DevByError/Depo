"""Business rules for projects: who may see and change what. Copy this file for a new resource."""

from __future__ import annotations

from typing import Any

from app.core.errors import Conflict, NotFound
from app.core.security import POLICY
from app.db.database import Connection, IntegrityError
from app.repositories.projects import ProjectRepository
from app.schemas.common import Page
from app.schemas.projects import ProjectIn, ProjectOut, ProjectUpdate

DUPLICATE = "You already have a project with this name."


class ProjectService:
    def __init__(self, conn: Connection, user: dict[str, Any]):
        self.repo = ProjectRepository(conn)
        self.user = user

    @property
    def sees_all(self) -> bool:
        """Admins work on everyone's projects; other users only on their own."""
        return POLICY.can(self.user["role"], "projects:any")

    def _get(self, project_id: int) -> dict[str, Any]:
        project = self.repo.get(project_id)
        # Someone else's project answers 404, not 403: it does not reveal that it exists.
        if not project or (project["owner_id"] != self.user["id"] and not self.sees_all):
            raise NotFound("This project does not exist.")
        return project

    def list(
        self, *, status: str | None, q: str | None, sort: str, page: int, page_size: int
    ) -> Page[ProjectOut]:
        rows, total = self.repo.list(
            owner_id=None if self.sees_all else self.user["id"],
            status=status,
            q=q,
            sort=sort,
            limit=page_size,
            offset=(page - 1) * page_size,
        )
        return Page[ProjectOut].of([ProjectOut(**r) for r in rows], total, page, page_size)

    def get(self, project_id: int) -> ProjectOut:
        return ProjectOut(**self._get(project_id))

    def create(self, data: ProjectIn) -> ProjectOut:
        try:
            row = self.repo.create(self.user["id"], data.name, data.description, data.status)
        except IntegrityError as exc:
            raise Conflict(DUPLICATE) from exc
        return ProjectOut(**row)

    def update(self, project_id: int, data: ProjectUpdate) -> ProjectOut:
        self._get(project_id)
        try:
            row = self.repo.update(project_id, data.changes())
        except IntegrityError as exc:
            raise Conflict(DUPLICATE) from exc
        assert row is not None
        return ProjectOut(**row)

    def delete(self, project_id: int) -> None:
        self._get(project_id)
        self.repo.delete(project_id)
