from collections.abc import Callable

from fastapi.testclient import TestClient

from app.core.security import create_access_token
from tests.helpers import PASSWORD, Headers


def test_sign_up_returns_a_token_and_the_user(client: TestClient) -> None:
    r = client.post("/api/auth/signup", json={"email": " Ana@Example.com ", "password": PASSWORD, "name": " Ana "})
    assert r.status_code == 201
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 3600
    assert body["user"] == {**body["user"], "email": "ana@example.com", "name": "Ana", "role": "user"}
    assert "password" not in str(body)


def test_sign_up_twice_is_a_conflict(client: TestClient, signup: Callable[..., Headers]) -> None:
    signup("ana@example.com")
    r = client.post("/api/auth/signup", json={"email": "ANA@example.com", "password": PASSWORD, "name": "A"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"


def test_sign_up_validates_every_field(client: TestClient) -> None:
    r = client.post("/api/auth/signup", json={"email": "not-an-email", "password": "short", "name": ""})
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "validation_error"
    fields = {d["field"] for d in error["details"]}
    assert fields == {"email", "password", "name"}
    email = next(d for d in error["details"] if d["field"] == "email")
    assert email["message"].startswith("Enter a valid email address")


def test_unknown_fields_are_refused(client: TestClient) -> None:
    r = client.post(
        "/api/auth/signup",
        json={"email": "a@example.com", "password": PASSWORD, "name": "A", "role": "admin"},
    )
    assert r.status_code == 422


def test_login_and_me(client: TestClient, signup: Callable[..., Headers]) -> None:
    signup("ana@example.com")
    r = client.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD})
    assert r.status_code == 200
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    me = client.get("/api/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["email"] == "ana@example.com"


def test_wrong_password_and_unknown_email_look_the_same(client: TestClient, signup: Callable[..., Headers]) -> None:
    signup("ana@example.com")
    wrong = client.post("/api/auth/login", json={"email": "ana@example.com", "password": "wrong password"})
    unknown = client.post("/api/auth/login", json={"email": "bob@example.com", "password": "wrong password"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["error"]["message"] == unknown.json()["error"]["message"] == "Wrong email or password."
    assert wrong.headers["WWW-Authenticate"] == "Bearer"


def test_me_needs_a_valid_token(client: TestClient, settings) -> None:  # type: ignore[no-untyped-def]
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    forged = create_access_token(1, "admin", "another-secret-" + "y" * 40, 60)
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
    expired = create_access_token(1, "user", settings.jwt_secret, -1)
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_failed_sign_ins_are_rate_limited(client: TestClient, signup: Callable[..., Headers]) -> None:
    signup("ana@example.com")
    for _ in range(5):
        r = client.post("/api/auth/login", json={"email": "ana@example.com", "password": "wrong password"})
        assert r.status_code == 401
    blocked = client.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD})
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "too_many_requests"
    # Other accounts are not affected.
    signup("bob@example.com")
    ok = client.post("/api/auth/login", json={"email": "bob@example.com", "password": PASSWORD})
    assert ok.status_code == 200
