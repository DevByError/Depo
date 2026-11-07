"""Test fixtures: a fresh SQLite database per test, a client, and signed-in users."""

from __future__ import annotations

import os

# Before the app is imported: a fixed secret and quiet logs for the module-level app.
os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 40)
os.environ.setdefault("LOG_LEVEL", "WARNING")

from collections.abc import Callable, Iterator  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import Settings  # noqa: E402
from app.db.database import Database  # noqa: E402
from app.main import create_app  # noqa: E402
from app.seed import seed  # noqa: E402
from tests.helpers import PASSWORD, Headers  # noqa: E402


@pytest.fixture
def settings(tmp_path) -> Settings:  # type: ignore[no-untyped-def]
    return Settings(
        database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        jwt_secret="s" * 48,
        log_level="WARNING",
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    # The context manager runs the app's start-up, which applies the migrations.
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture
def signup(client: TestClient) -> Callable[..., Headers]:
    """Sign up a user and return the Authorization header for them."""

    def make(email: str = "ana@example.com", name: str = "Ana", password: str = PASSWORD) -> Headers:
        r = client.post("/api/auth/signup", json={"email": email, "password": password, "name": name})
        assert r.status_code == 201, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    return make


@pytest.fixture
def user(signup: Callable[..., Headers]) -> Headers:
    return signup()


@pytest.fixture
def admin(client: TestClient, settings: Settings) -> Headers:
    assert seed(Database(settings.database_url), "admin@example.com", PASSWORD) == "created"
    r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
