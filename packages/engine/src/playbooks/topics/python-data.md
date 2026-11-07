---
title: SQLAlchemy 2, SQLModel and Alembic
summary: Typed models, sessions, queries without N+1, async engines, migrations with Alembic, constraint naming.
agents: backend, database, enhancement, testing, coder
triggers: sqlalchemy, sqlmodel, alembic, orm, asyncpg, psycopg, migration, migrations
---
# SQLAlchemy 2, SQLModel and Alembic

## Models (SQLAlchemy 2 typed style)
```python
from datetime import datetime
from sqlalchemy import ForeignKey, MetaData, String, UniqueConstraint, CheckConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)  # stable names make Alembic diffs reliable

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    bookings: Mapped[list["Booking"]] = relationship(back_populates="user")

class Booking(Base):
    __tablename__ = "bookings"
    __table_args__ = (
        UniqueConstraint("doctor_id", "starts_at", name="doctor_slot"),
        CheckConstraint("status in ('pending','confirmed','cancelled')", name="status_valid"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id", ondelete="RESTRICT"), index=True)
    starts_at: Mapped[datetime] = mapped_column(index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    user: Mapped[User] = relationship(back_populates="bookings")
```
`Mapped[str | None]` makes a column nullable; plain `Mapped[str]` is NOT NULL. Store emails lower-cased in the service.

## Engine and sessions
```python
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)

def get_db():
    with SessionLocal() as session:
        yield session
```
Async: `create_async_engine("postgresql+asyncpg://...")`, `async_sessionmaker(engine, expire_on_commit=False)`, `async with session.begin():`. Never share a session between concurrent requests.

## Queries (2.0 style)
```python
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload

stmt = (
    select(Booking)
    .where(Booking.user_id == user.id, Booking.status != "cancelled")
    .options(selectinload(Booking.doctor))      # avoids N+1 when the response includes the doctor
    .order_by(Booking.starts_at.desc(), Booking.id.desc())
    .limit(limit).offset(offset)
)
items = db.scalars(stmt).all()
total = db.scalar(select(func.count()).select_from(Booking).where(Booking.user_id == user.id))
one = db.get(Booking, booking_id)               # by primary key
```
- `selectinload` for collections, `joinedload` for many-to-one. Turn on `echo=True` locally to count queries.
- Writes: `with db.begin(): db.add(obj)` or `db.add(obj); db.commit(); db.refresh(obj)`. Multi-row business operations go in one transaction.
- Catch `sqlalchemy.exc.IntegrityError`, roll back, and raise a 409 domain error.
- Row locks for read-modify-write: `select(Stock).where(...).with_for_update()`.
- Never build SQL with f-strings; use bound parameters (`text("... where id = :id")`, `{"id": x}`).

## SQLModel (when the project already uses it)
```python
from sqlmodel import Field, SQLModel

class HeroBase(SQLModel):
    name: str = Field(index=True, max_length=100)

class Hero(HeroBase, table=True):
    id: int | None = Field(default=None, primary_key=True)

class HeroCreate(HeroBase): ...
class HeroPublic(HeroBase):
    id: int
```
Keep separate table and API models, exactly as with plain SQLAlchemy plus Pydantic.

## Alembic
```
pip install alembic
alembic init alembic                # or: alembic init -t async alembic
```
In `alembic/env.py`: import your `Base` and set `target_metadata = Base.metadata`; read the URL from settings (`config.set_main_option("sqlalchemy.url", settings.database_url)`). Then:
```
alembic revision --autogenerate -m "create users and bookings"
alembic upgrade head
alembic downgrade -1                # check the downgrade works too
```
- Always read the generated file: autogenerate misses some changes (renames become drop plus add, server defaults, some constraint changes) and may emit nothing for check constraints.
- One migration per logical change; never edit a migration that has been applied anywhere.
- Data migrations: use `op.execute` with plain SQL, not ORM models (models change later).
- Adding a NOT NULL column to a filled table: add nullable, backfill, then alter to NOT NULL.
- SQLite needs batch mode for ALTER: `with op.batch_alter_table("users") as batch: ...` (set `render_as_batch=True` in env.py).

## Tests
Use a separate database: SQLite in memory for fast unit tests only when the app avoids PostgreSQL-specific features; otherwise a PostgreSQL test database (docker compose service) with each test inside a transaction that is rolled back. Run `alembic upgrade head` against the test database once per session to test the migrations themselves.
