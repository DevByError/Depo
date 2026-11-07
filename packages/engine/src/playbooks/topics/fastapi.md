---
title: FastAPI services
summary: Project layout, routers, Pydantic v2 models, dependencies, pydantic-settings, error handlers, pagination, async rules.
agents: backend, integration, testing, ai-integration, security, enhancement, coder
triggers: fastapi, uvicorn, pydantic, starlette, python api
---
# FastAPI services

## Layout
```
app/
  main.py            # create_app(), routers, exception handlers, lifespan
  core/config.py     # Settings (pydantic-settings)
  core/security.py   # hashing, tokens, current_user dependency
  db.py              # engine, session dependency
  models/            # SQLAlchemy models
  schemas/           # Pydantic request/response models
  routers/           # one APIRouter per area: auth.py, bookings.py
  services/          # business rules, no HTTP types here
tests/
alembic/
```

## Settings
```python
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = "sqlite:///./app.db"
    jwt_secret: str = Field(min_length=32)
    access_token_minutes: int = 15
    cors_origins: list[str] = ["http://localhost:5173"]

settings = Settings()  # fails at startup with a clear error when JWT_SECRET is missing
```

## Schemas (Pydantic v2)
```python
from datetime import datetime
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

class BookingCreate(BaseModel):
    doctor_id: int
    starts_at: datetime
    note: str | None = Field(default=None, max_length=500)

    @field_validator("starts_at")
    @classmethod
    def must_be_aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("Include a time zone, for example 2026-03-01T09:30:00Z.")
        return v

class BookingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)  # build from ORM objects
    id: int
    doctor_id: int
    starts_at: datetime
    status: str

T = TypeVar("T")  # from typing import Generic, TypeVar

class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int
```
`EmailStr` needs the `email-validator` package. Use `model_validate(obj)` and `model_dump(exclude_unset=True)` (for PATCH) instead of the v1 `from_orm`/`dict`.

## Dependencies and routers
```python
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]

router = APIRouter(prefix="/api/v1/bookings", tags=["bookings"])

@router.get("", response_model=Page[BookingOut])
def list_bookings(
    db: DbSession,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    items, total = booking_service.list_for(db, user, limit=limit, offset=offset)
    return Page(items=items, total=total, limit=limit, offset=offset)

@router.post("", response_model=BookingOut, status_code=status.HTTP_201_CREATED)
def create_booking(body: BookingCreate, db: DbSession, user: CurrentUser):
    return booking_service.create(db, user, body)
```
`get_db` yields a session and closes it in `finally`. Put permission checks in dependencies (`Depends(require_permission("booking:manage"))`) so routes stay declarative. Ownership checks belong in the service: load by id *and* owner, raise not found otherwise.

## Errors in one place
```python
class AppError(Exception):
    def __init__(self, status: int, title: str, detail: str = "", errors: list[dict] | None = None):
        self.status, self.title, self.detail, self.errors = status, title, detail, errors or []

@app.exception_handler(AppError)
async def app_error(_req, exc: AppError):
    return JSONResponse(status_code=exc.status, media_type="application/problem+json",
        content={"title": exc.title, "status": exc.status, "detail": exc.detail, "errors": exc.errors})

@app.exception_handler(RequestValidationError)
async def validation_error(_req, exc: RequestValidationError):
    errors = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
    return JSONResponse(status_code=422, media_type="application/problem+json",
        content={"title": "Invalid request", "status": 422, "errors": errors})
```
Services raise `AppError(409, "Slot taken")` or a `NotFound` subclass; catch `IntegrityError` from unique constraints and turn it into 409.

## App factory, lifespan, CORS
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield  # open pools or load models before, close after

def create_app() -> FastAPI:
    app = FastAPI(title="Clinic API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins,
                       allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
    app.include_router(auth.router)
    app.include_router(bookings.router)
    return app

app = create_app()
```
Docs are served at `/docs` and `/openapi.json`. Run with `uvicorn app.main:app --reload --port 8000`.

## Async rules
- `async def` routes must only await non-blocking libraries (asyncpg, httpx.AsyncClient, SQLAlchemy async). A blocking call inside `async def` freezes every request.
- Plain `def` routes run in a thread pool: fine for sync SQLAlchemy sessions.
- Long work goes to a background worker (arq, Celery, RQ) or `BackgroundTasks` for small fire-and-forget jobs.

## Testing
```python
from fastapi.testclient import TestClient

def test_booking_requires_login(client: TestClient):
    r = client.post("/api/v1/bookings", json={"doctor_id": 1, "starts_at": "2026-03-01T09:00:00Z"})
    assert r.status_code == 401
```
Override dependencies for tests: `app.dependency_overrides[get_db] = lambda: test_session`. For async code use `httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")` with pytest-asyncio or anyio.
