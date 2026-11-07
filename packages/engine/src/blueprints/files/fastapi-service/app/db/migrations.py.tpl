"""Schema changes as numbered steps. Add a new step at the end; never edit a step that has run.

{pk} becomes the auto-increment primary key of the database in use. Constraints, not code,
enforce the rules (NOT NULL, UNIQUE, CHECK, foreign keys), and foreign keys are indexed.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.db.database import Database

MIGRATIONS: list[tuple[int, str, str]] = [
    (
        1,
        "users",
        """
        CREATE TABLE users (
            id {pk},
            email TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
            created_at TEXT NOT NULL
        );
        """,
    ),
    (
        2,
        "projects",
        """
        CREATE TABLE projects (
            id {pk},
            owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (owner_id, name)
        );
        CREATE INDEX ix_projects_owner ON projects (owner_id);
        CREATE INDEX ix_projects_status ON projects (status);
        """,
    ),
]

PRIMARY_KEY = {"sqlite": "INTEGER PRIMARY KEY AUTOINCREMENT", "postgresql": "SERIAL PRIMARY KEY"}


def migrate(db: Database) -> list[int]:
    """Apply the steps that have not run yet, in order. Returns the numbers it applied."""
    applied: list[int] = []
    with db.session() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        done = {row["version"] for row in conn.all("SELECT version FROM schema_migrations")}
        for version, name, sql in MIGRATIONS:
            if version in done:
                continue
            for statement in sql.replace("{pk}", PRIMARY_KEY[db.dialect]).split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (:version, :name, :at)",
                {"version": version, "name": name, "at": datetime.now(timezone.utc).isoformat()},
            )
            applied.append(version)
    return applied
