"""The database layer: SQLite out of the box, PostgreSQL by changing DATABASE_URL.

Repositories write SQL with named parameters (:name) and never build SQL from user input.
SQLite runs it as is; for PostgreSQL the parameters become %(name)s. To switch:
    pip install "psycopg[binary]"
    DATABASE_URL=postgresql://app:password@localhost:5432/app
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

_PARAM = re.compile(r"(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)")


def to_pyformat(sql: str) -> str:
    """':name' becomes '%(name)s' for PostgreSQL drivers; '::type' casts and a literal % are kept."""
    return _PARAM.sub(r"%(\1)s", sql.replace("%", "%%"))


class IntegrityError(Exception):
    """A constraint failed (UNIQUE, FOREIGN KEY, CHECK, NOT NULL), whichever database is in use."""


class Connection:
    def __init__(self, raw: Any, dialect: str, integrity: tuple[type[BaseException], ...]):
        self.raw = raw
        self.dialect = dialect
        self._integrity = integrity

    def execute(self, sql: str, params: dict[str, Any] | None = None) -> Any:
        text = sql if self.dialect == "sqlite" else to_pyformat(sql)
        cur = self.raw.cursor()
        try:
            cur.execute(text, params or {})
        except self._integrity as exc:
            raise IntegrityError(str(exc)) from exc
        return cur

    def one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        row = self.execute(sql, params).fetchone()
        return dict(row) if row is not None else None

    def all(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return [dict(r) for r in self.execute(sql, params).fetchall()]

    def scalar(self, sql: str, params: dict[str, Any] | None = None) -> Any:
        row = self.execute(sql, params).fetchone()
        if row is None:
            return None
        return row[0] if self.dialect == "sqlite" else next(iter(dict(row).values()))

    def insert(self, sql: str, params: dict[str, Any]) -> int:
        """Run an INSERT and return the new row's id."""
        if self.dialect == "sqlite":
            return int(self.execute(sql, params).lastrowid)
        return int(self.scalar(f"{sql} RETURNING id", params))

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()

    def close(self) -> None:
        self.raw.close()


class Database:
    def __init__(self, url: str, base_dir: Path | None = None):
        self.url = url
        if url.startswith("sqlite:///"):
            self.dialect = "sqlite"
            raw = url[len("sqlite:///") :]
            if not raw or raw == ":memory:":
                raise ValueError("Use a database file: each connection to :memory: starts empty.")
            path = Path(raw)
            self.path = path if path.is_absolute() else (base_dir or Path.cwd()) / path
        elif url.startswith(("postgresql://", "postgres://")):
            self.dialect = "postgresql"
        else:
            raise ValueError("DATABASE_URL must start with sqlite:/// or postgresql://")

    def connect(self) -> Connection:
        if self.dialect == "sqlite":
            self.path.parent.mkdir(parents=True, exist_ok=True)
            raw = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
            raw.row_factory = sqlite3.Row
            raw.execute("PRAGMA foreign_keys = ON")
            return Connection(raw, "sqlite", (sqlite3.IntegrityError,))
        try:
            import psycopg  # type: ignore[import-not-found]
            from psycopg.rows import dict_row  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError('PostgreSQL needs the psycopg package: pip install "psycopg[binary]"') from exc
        raw = psycopg.connect(self.url, row_factory=dict_row)
        return Connection(raw, "postgresql", (psycopg.IntegrityError,))

    @contextmanager
    def session(self) -> Iterator[Connection]:
        """A connection that commits when the block succeeds and rolls back when it fails."""
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
