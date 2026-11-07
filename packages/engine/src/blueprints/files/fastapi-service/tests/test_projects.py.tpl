"""The example resource end to end: copy these tests for each new resource."""

from fastapi.testclient import TestClient

from tests.helpers import Headers


def test_crud(client: TestClient, user: Headers) -> None:
    r = client.post("/api/projects", json={"name": "  Launch  ", "description": "Ship v1"}, headers=user)
    assert r.status_code == 201
    project = r.json()
    assert project["name"] == "Launch"
    assert project["status"] == "active"

    got = client.get(f"/api/projects/{project['id']}", headers=user)
    assert got.status_code == 200
    assert got.json() == project

    changed = client.patch(f"/api/projects/{project['id']}", json={"status": "done"}, headers=user)
    assert changed.status_code == 200
    assert changed.json()["status"] == "done"
    assert changed.json()["description"] == "Ship v1"
    assert changed.json()["updated_at"] >= project["updated_at"]

    assert client.delete(f"/api/projects/{project['id']}", headers=user).status_code == 204
    assert client.get(f"/api/projects/{project['id']}", headers=user).status_code == 404
    assert client.delete(f"/api/projects/{project['id']}", headers=user).status_code == 404


def test_projects_need_a_signed_in_user(client: TestClient) -> None:
    assert client.get("/api/projects").status_code == 401
    assert client.post("/api/projects", json={"name": "x"}).status_code == 401


def test_validation(client: TestClient, user: Headers) -> None:
    cases = [
        ({"name": ""}, "name"),
        ({"name": "   "}, "name"),
        ({"name": "x" * 121}, "name"),
        ({"name": "ok", "status": "archived"}, "status"),
        ({"name": "ok", "description": "x" * 2001}, "description"),
        ({"name": "ok", "owner_id": 5}, "owner_id"),
    ]
    for body, field in cases:
        r = client.post("/api/projects", json=body, headers=user)
        assert r.status_code == 422, body
        assert field in {d["field"] for d in r.json()["error"]["details"]}, body
    project = client.post("/api/projects", json={"name": "ok"}, headers=user).json()
    assert client.patch(f"/api/projects/{project['id']}", json={}, headers=user).status_code == 422
    assert client.patch(f"/api/projects/{project['id']}", json={"status": None}, headers=user).status_code == 422
    assert client.get("/api/projects/0", headers=user).status_code == 422


def test_names_are_unique_per_owner(client: TestClient, user: Headers, signup) -> None:  # type: ignore[no-untyped-def]
    assert client.post("/api/projects", json={"name": "Same"}, headers=user).status_code == 201
    again = client.post("/api/projects", json={"name": "Same"}, headers=user)
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "conflict"
    other = signup("bob@example.com", "Bob")
    assert client.post("/api/projects", json={"name": "Same"}, headers=other).status_code == 201
    second = client.post("/api/projects", json={"name": "Second"}, headers=user).json()
    rename = client.patch(f"/api/projects/{second['id']}", json={"name": "Same"}, headers=user)
    assert rename.status_code == 409


def test_pagination(client: TestClient, user: Headers) -> None:
    for i in range(25):
        assert client.post("/api/projects", json={"name": f"Project {i:02d}"}, headers=user).status_code == 201
    first = client.get("/api/projects", params={"page_size": 10, "sort": "name"}, headers=user).json()
    assert (first["total"], first["pages"], first["page"], first["page_size"]) == (25, 3, 1, 10)
    assert [p["name"] for p in first["items"]][:2] == ["Project 00", "Project 01"]
    last = client.get("/api/projects", params={"page_size": 10, "page": 3, "sort": "name"}, headers=user).json()
    assert len(last["items"]) == 5
    beyond = client.get("/api/projects", params={"page": 9}, headers=user).json()
    assert beyond["items"] == [] and beyond["total"] == 25
    newest = client.get("/api/projects", params={"page_size": 1}, headers=user).json()
    assert newest["items"][0]["name"] == "Project 24"
    for bad in ({"page_size": 101}, {"page_size": 0}, {"page": 0}, {"sort": "password"}):
        assert client.get("/api/projects", params=bad, headers=user).status_code == 422, bad


def test_filtering_and_search(client: TestClient, user: Headers) -> None:
    for name, status in [("Alpha site", "active"), ("Beta app", "paused"), ("Gamma site", "done"), ("100%_real", "active")]:
        client.post("/api/projects", json={"name": name, "status": status}, headers=user)
    paused = client.get("/api/projects", params={"status": "paused"}, headers=user).json()
    assert [p["name"] for p in paused["items"]] == ["Beta app"]
    sites = client.get("/api/projects", params={"q": "SITE", "sort": "name"}, headers=user).json()
    assert [p["name"] for p in sites["items"]] == ["Alpha site", "Gamma site"]
    both = client.get("/api/projects", params={"q": "site", "status": "done"}, headers=user).json()
    assert [p["name"] for p in both["items"]] == ["Gamma site"]
    # % and _ are searched literally, not as wildcards.
    literal = client.get("/api/projects", params={"q": "%_"}, headers=user).json()
    assert [p["name"] for p in literal["items"]] == ["100%_real"]
