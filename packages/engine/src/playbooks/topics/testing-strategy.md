---
title: Testing strategy and tools
summary: Test pyramid, what to test per layer, pytest fixtures and test databases, Vitest and supertest, Testing Library, Playwright end-to-end with axe.
agents: testing, backend, frontend, reasoning, integration, coder
triggers: test, tests, testing, pytest, jest, vitest, playwright, cypress, e2e, end-to-end, unit test, integration test, coverage, tdd, supertest
---
# Testing strategy and tools

## The pyramid
- **Unit** (many, milliseconds): business rules and pure functions: price calculation, availability, permission checks, validators.
- **Integration and API** (some, seconds): each route through the real framework and a real test database: success, validation error, 401, 403, 404, 409. Repositories against the database (constraints really fire).
- **End-to-end** (few, slower): the main user stories through the real UI and API with Playwright: sign up or sign in, the core workflow, an admin action.
- **Contract**: the API matches openapi.yaml (schemathesis, or a test comparing routes to the spec).
Tests decide whether work is done. A criterion without a test is not done.

## Good tests
- Arrange, act, assert; one behaviour per test; the name says the behaviour (`test_overlapping_booking_returns_409`).
- Assert outcomes: status code **and** body **and** the state change (row created, email queued), not internal calls.
- Independent: each test creates its own data (factories) and leaves nothing behind (transaction rollback or truncation).
- Deterministic: freeze time (freezegun, time-machine, `vi.useFakeTimers()`), seed random generators, no real network (mock HTTP with respx or MSW).
- Fast enough to run on every change; mark slow suites and run them in CI.

## Python: pytest
```python
# tests/conftest.py
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.main import app
from app.db import Base, get_db

engine = create_engine("sqlite+pysqlite:///:memory:", connect_args={"check_same_thread": False},
                       poolclass=StaticPool)  # from sqlalchemy.pool import StaticPool
TestingSession = sessionmaker(engine, expire_on_commit=False)

@pytest.fixture(autouse=True)
def schema():
    Base.metadata.create_all(engine)
    yield
    Base.metadata.drop_all(engine)

@pytest.fixture
def db():
    with TestingSession() as s:
        yield s

@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()

@pytest.fixture
def auth_headers(client, db):
    make_user(db, email="ana@example.com", password="correct horse battery")
    token = client.post("/api/v1/auth/login", json={"email": "ana@example.com", "password": "correct horse battery"}).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}
```
Use a PostgreSQL test database (docker compose service, or testcontainers) when the app relies on PostgreSQL features (exclusion constraints, jsonb, ILIKE). `pytest -q`, `pytest -x` (stop at first failure), `pytest -k booking`, `pytest --cov=app --cov-report=term-missing` (pytest-cov). Parametrize matrices:
```python
@pytest.mark.parametrize("role,status", [("anonymous", 401), ("member", 403), ("admin", 204)])
def test_delete_user_permissions(role, status, client, headers_for): ...
```

## JavaScript and TypeScript
- Vitest (or Jest, or `bun test`) for units; supertest (`request(app).get("/x")`) or Fastify `inject` for routes; a test database reset per file.
- React: Testing Library; query like a user (`getByRole("button", { name: "Save" })`, `getByLabelText("Email")`), use `userEvent` for typing and clicks, `findBy*` to wait. Mock the API at the network level with MSW so components use their real client.
- Avoid snapshot tests as the only assertion; they pass while behaviour breaks.

## Playwright end-to-end
```ts
// playwright.config.ts
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://127.0.0.1:5173", trace: "on-first-retry" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:5173", reuseExistingServer: true },
});

// e2e/booking.spec.ts
import AxeBuilder from "@axe-core/playwright";
test("a patient books and sees the booking", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("patient@example.com");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "demo-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Book an appointment" }).click();
  await page.getByLabel("Doctor").selectOption({ label: "Dr Rivera" });
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("status")).toHaveText(/Booking confirmed/);
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(a11y.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
```
Locators auto-wait; never use fixed sleeps. Seed the database before the run (a seed script or an API call in `globalSetup`). Install browsers once with `npx playwright install chromium`.

## Fix loop discipline
Run the whole suite, read the first failure fully, reproduce it alone (`pytest tests/test_x.py::test_y`, `vitest run -t "name"`), fix the cause, rerun the single test, then the suite. If a test is wrong, change it and explain why in the summary. Record flaky tests (passes and fails without code changes) with what makes them flaky: shared state, time, ordering, real network.

## Report
reviews/test-report.md: the command, totals (passed, failed, skipped), coverage if measured, which acceptance criteria each test file covers, known gaps and flaky tests.
