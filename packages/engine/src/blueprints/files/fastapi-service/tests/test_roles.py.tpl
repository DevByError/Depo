from collections.abc import Callable

from fastapi.testclient import TestClient

from app.core.security import POLICY
from tests.helpers import Headers


def test_the_policy_denies_by_default() -> None:
    assert POLICY.can("user", "projects:create")
    assert not POLICY.can("user", "users:read")
    assert POLICY.can("admin", "users:read")
    assert POLICY.can("admin", "projects:delete")  # inherited from user
    assert not POLICY.can("guest", "projects:read")


def test_only_admins_list_users(client: TestClient, user: Headers, admin: Headers) -> None:
    assert client.get("/api/users").status_code == 401
    denied = client.get("/api/users", headers=user)
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "forbidden"
    r = client.get("/api/users", headers=admin)
    assert r.status_code == 200
    assert r.json()["total"] == 2
    assert {u["role"] for u in r.json()["items"]} == {"user", "admin"}
    found = client.get("/api/users", params={"q": "ANA"}, headers=admin).json()
    assert [u["email"] for u in found["items"]] == ["ana@example.com"]


def test_admins_change_roles_and_it_applies_at_once(client: TestClient, user: Headers, admin: Headers) -> None:
    me = client.get("/api/auth/me", headers=user).json()
    assert client.patch(f"/api/users/{me['id']}/role", json={"role": "admin"}, headers=user).status_code == 403
    r = client.patch(f"/api/users/{me['id']}/role", json={"role": "admin"}, headers=admin)
    assert r.status_code == 200
    assert r.json()["role"] == "admin"
    # The same token now has admin rights: the role is read from the database.
    assert client.get("/api/users", headers=user).status_code == 200


def test_roles_are_validated_and_the_last_admin_stays(client: TestClient, admin: Headers) -> None:
    me = client.get("/api/auth/me", headers=admin).json()
    bad = client.patch(f"/api/users/{me['id']}/role", json={"role": "owner"}, headers=admin)
    assert bad.status_code == 422
    last = client.patch(f"/api/users/{me['id']}/role", json={"role": "user"}, headers=admin)
    assert last.status_code == 409
    missing = client.patch("/api/users/9999/role", json={"role": "user"}, headers=admin)
    assert missing.status_code == 404


def test_users_see_only_their_own_projects(
    client: TestClient, signup: Callable[..., Headers], admin: Headers
) -> None:
    ana = signup("ana@example.com", "Ana")
    bob = signup("bob@example.com", "Bob")
    created = client.post("/api/projects", json={"name": "Ana's plan"}, headers=ana).json()
    client.post("/api/projects", json={"name": "Bob's plan"}, headers=bob)

    assert [p["name"] for p in client.get("/api/projects", headers=ana).json()["items"]] == ["Ana's plan"]
    assert client.get(f"/api/projects/{created['id']}", headers=bob).status_code == 404
    assert client.patch(f"/api/projects/{created['id']}", json={"name": "x"}, headers=bob).status_code == 404
    assert client.delete(f"/api/projects/{created['id']}", headers=bob).status_code == 404
    # Admins see and manage everyone's.
    assert client.get("/api/projects", headers=admin).json()["total"] == 2
    assert client.get(f"/api/projects/{created['id']}", headers=admin).status_code == 200
