"""SQL for users. Repositories only talk to the database: no HTTP, no permission checks."""

from __future__ import annotations

from typing import Any

from app.db.database import Connection
from app.repositories.util import like_pattern, now

COLUMNS = "id, email, name, role, created_at"


class UserRepository:
    def __init__(self, conn: Connection):
        self.conn = conn

    def get(self, user_id: int) -> dict[str, Any] | None:
        return self.conn.one(f"SELECT {COLUMNS} FROM users WHERE id = :id", {"id": user_id})

    def credentials(self, email: str) -> dict[str, Any] | None:
        """The user with the password hash, for signing in only."""
        return self.conn.one(f"SELECT {COLUMNS}, password_hash FROM users WHERE email = :email", {"email": email})

    def create(self, email: str, name: str, password_hash: str, role: str = "user") -> dict[str, Any]:
        new_id = self.conn.insert(
            "INSERT INTO users (email, name, password_hash, role, created_at) "
            "VALUES (:email, :name, :password_hash, :role, :created_at)",
            {"email": email, "name": name, "password_hash": password_hash, "role": role, "created_at": now()},
        )
        user = self.get(new_id)
        assert user is not None
        return user

    def set_role(self, user_id: int, role: str) -> dict[str, Any] | None:
        self.conn.execute("UPDATE users SET role = :role WHERE id = :id", {"role": role, "id": user_id})
        return self.get(user_id)

    def set_password(self, user_id: int, password_hash: str) -> None:
        self.conn.execute("UPDATE users SET password_hash = :h WHERE id = :id", {"h": password_hash, "id": user_id})

    def count_admins(self) -> int:
        return int(self.conn.scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'"))

    def list(self, *, q: str | None, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
        where, params = "", {}
        if q:
            where = " WHERE LOWER(email) LIKE :q ESCAPE '\\' OR LOWER(name) LIKE :q ESCAPE '\\'"
            params["q"] = like_pattern(q)
        total = int(self.conn.scalar(f"SELECT COUNT(*) FROM users{where}", params))
        rows = self.conn.all(
            f"SELECT {COLUMNS} FROM users{where} ORDER BY id LIMIT :limit OFFSET :offset",
            {**params, "limit": limit, "offset": offset},
        )
        return rows, total
