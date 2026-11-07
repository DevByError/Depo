"""SQL for projects. Copy this file for a new resource; keep sorting on a fixed list of columns."""

from __future__ import annotations

from typing import Any

from app.db.database import Connection
from app.repositories.util import like_pattern, now

# Only these orders exist, so user input never reaches the SQL text.
SORTS = {
    "name": "LOWER(name) ASC, id ASC",
    "-name": "LOWER(name) DESC, id DESC",
    "created_at": "created_at ASC, id ASC",
    "-created_at": "created_at DESC, id DESC",
    "updated_at": "updated_at ASC, id ASC",
    "-updated_at": "updated_at DESC, id DESC",
}
EDITABLE = ("name", "description", "status")


class ProjectRepository:
    def __init__(self, conn: Connection):
        self.conn = conn

    def get(self, project_id: int) -> dict[str, Any] | None:
        return self.conn.one("SELECT * FROM projects WHERE id = :id", {"id": project_id})

    def list(
        self,
        *,
        owner_id: int | None,
        status: str | None,
        q: str | None,
        sort: str,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        where: list[str] = []
        params: dict[str, Any] = {}
        if owner_id is not None:
            where.append("owner_id = :owner_id")
            params["owner_id"] = owner_id
        if status:
            where.append("status = :status")
            params["status"] = status
        if q:
            where.append("LOWER(name) LIKE :q ESCAPE '\\'")
            params["q"] = like_pattern(q)
        clause = f" WHERE {' AND '.join(where)}" if where else ""
        total = int(self.conn.scalar(f"SELECT COUNT(*) FROM projects{clause}", params))
        rows = self.conn.all(
            f"SELECT * FROM projects{clause} ORDER BY {SORTS[sort]} LIMIT :limit OFFSET :offset",
            {**params, "limit": limit, "offset": offset},
        )
        return rows, total

    def create(self, owner_id: int, name: str, description: str, status: str) -> dict[str, Any]:
        at = now()
        new_id = self.conn.insert(
            "INSERT INTO projects (owner_id, name, description, status, created_at, updated_at) "
            "VALUES (:owner_id, :name, :description, :status, :at, :at)",
            {"owner_id": owner_id, "name": name, "description": description, "status": status, "at": at},
        )
        project = self.get(new_id)
        assert project is not None
        return project

    def update(self, project_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        fields = {k: v for k, v in changes.items() if k in EDITABLE}
        if fields:
            assignments = ", ".join(f"{k} = :{k}" for k in fields)
            self.conn.execute(
                f"UPDATE projects SET {assignments}, updated_at = :updated_at WHERE id = :id",
                {**fields, "updated_at": now(), "id": project_id},
            )
        return self.get(project_id)

    def delete(self, project_id: int) -> bool:
        return self.conn.execute("DELETE FROM projects WHERE id = :id", {"id": project_id}).rowcount > 0
