from pathlib import Path

import pytest

from app.db.database import Database, to_pyformat
from app.db.migrations import MIGRATIONS, migrate
from app.seed import seed
from tests.helpers import PASSWORD


def test_named_parameters_become_postgres_style() -> None:
    sql = "SELECT * FROM t WHERE a = :a AND b::text LIKE :b_2 AND c = '10:30' AND d LIKE 'x%'"
    assert to_pyformat(sql) == (
        "SELECT * FROM t WHERE a = %(a)s AND b::text LIKE %(b_2)s AND c = '10:30' AND d LIKE 'x%%'"
    )


def test_database_urls() -> None:
    assert Database("sqlite:///data/app.db", base_dir=Path("/srv/app")).path == Path("/srv/app/data/app.db")
    assert Database("postgresql://app:pw@localhost:5432/app").dialect == "postgresql"
    with pytest.raises(ValueError):
        Database("mysql://localhost/app")
    with pytest.raises(ValueError):
        Database("sqlite:///:memory:")


def test_migrations_run_once_and_in_order(tmp_path: Path) -> None:
    db = Database(f"sqlite:///{(tmp_path / 'm.db').as_posix()}")
    assert migrate(db) == [v for v, _, _ in MIGRATIONS]
    assert migrate(db) == []
    versions = [v for v, _, _ in MIGRATIONS]
    assert versions == sorted(versions) and len(set(versions)) == len(versions)


def test_constraints_hold_in_the_database(tmp_path: Path) -> None:
    db = Database(f"sqlite:///{(tmp_path / 'c.db').as_posix()}")
    migrate(db)
    from app.db.database import IntegrityError

    with pytest.raises(IntegrityError), db.session() as conn:
        conn.execute(
            "INSERT INTO users (email, name, password_hash, role, created_at) VALUES ('a@b.co', 'A', 'h', 'boss', 'now')"
        )
    with pytest.raises(IntegrityError), db.session() as conn:
        conn.execute(
            "INSERT INTO projects (owner_id, name, status, created_at, updated_at) VALUES (999, 'x', 'active', 'n', 'n')"
        )


def test_seed_is_safe_to_run_twice(tmp_path: Path) -> None:
    db = Database(f"sqlite:///{(tmp_path / 's.db').as_posix()}")
    assert seed(db, "Admin@Example.com", PASSWORD, demo=True) == "created"
    assert seed(db, "admin@example.com", PASSWORD, demo=True) == "exists"
    with db.session() as conn:
        assert conn.scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'") == 1
        assert conn.scalar("SELECT COUNT(*) FROM projects") == 2
