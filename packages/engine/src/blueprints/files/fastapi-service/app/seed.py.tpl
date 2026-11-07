"""Create the first admin, and optionally demo data. Safe to run more than once.

    python -m app.seed          the admin from ADMIN_EMAIL and ADMIN_PASSWORD (.env)
    python -m app.seed --demo   also two demo projects owned by the admin
"""

from __future__ import annotations

import argparse
import os
import sys

from app.core.config import BASE_DIR, load_dotenv
from app.core.passwords import MIN_PASSWORD_LENGTH, hash_password
from app.db.database import Database
from app.db.migrations import migrate
from app.repositories.projects import ProjectRepository
from app.repositories.users import UserRepository

DEMO_PROJECTS = [
    ("Website refresh", "New landing page and pricing table.", "active"),
    ("Mobile app", "First release for Android and iOS.", "paused"),
]


def seed(db: Database, email: str, password: str, name: str = "Admin", demo: bool = False) -> str:
    """Make sure an admin with this email exists. Returns "created", "promoted" or "exists"."""
    migrate(db)
    with db.session() as conn:
        users = UserRepository(conn)
        found = users.credentials(email.strip().lower())
        if found is None:
            admin = users.create(email.strip().lower(), name, hash_password(password), role="admin")
            result = "created"
        elif found["role"] != "admin":
            admin = users.set_role(found["id"], "admin") or found
            result = "promoted"
        else:
            admin = found
            result = "exists"
        if demo:
            projects = ProjectRepository(conn)
            mine, _ = projects.list(owner_id=admin["id"], status=None, q=None, sort="name", limit=100, offset=0)
            have = {p["name"] for p in mine}
            for title, description, status in DEMO_PROJECTS:
                if title not in have:
                    projects.create(admin["id"], title, description, status)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Create the first admin (and demo data).")
    parser.add_argument("--demo", action="store_true", help="also add demo projects")
    args = parser.parse_args(argv)
    load_dotenv(BASE_DIR / ".env")
    email = os.environ.get("ADMIN_EMAIL", "").strip()
    password = os.environ.get("ADMIN_PASSWORD", "")
    if not email or not password:
        print("No admin created: set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then run python -m app.seed again.")
        return 0
    if len(password) < MIN_PASSWORD_LENGTH:
        print(f"ADMIN_PASSWORD must be at least {MIN_PASSWORD_LENGTH} characters long.", file=sys.stderr)
        return 1
    db = Database(os.environ.get("DATABASE_URL", "sqlite:///data/app.db"), base_dir=BASE_DIR)
    result = seed(db, email, password, demo=args.demo)
    print(f"Admin {email}: {result}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
