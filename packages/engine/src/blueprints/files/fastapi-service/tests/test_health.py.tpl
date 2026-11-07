from fastapi.testclient import TestClient


def test_health_reports_the_database(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["database"] == "ok"


def test_every_response_has_a_request_id(client: TestClient) -> None:
    r = client.get("/api/health")
    assert len(r.headers["X-Request-ID"]) >= 8
    mine = client.get("/api/health", headers={"X-Request-ID": "my-trace-1234"})
    assert mine.headers["X-Request-ID"] == "my-trace-1234"
    unsafe = client.get("/api/health", headers={"X-Request-ID": "bad id\r\nx"})
    assert unsafe.headers["X-Request-ID"] != "bad id\r\nx"


def test_unknown_routes_use_the_error_format(client: TestClient) -> None:
    r = client.get("/api/nothing-here")
    assert r.status_code == 404
    error = r.json()["error"]
    assert error["code"] == "not_found"
    assert error["request_id"] == r.headers["X-Request-ID"]
