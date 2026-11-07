"""Builds the app: settings, database, logging, errors, CORS and the routers.

Run it with: python -m uvicorn app.main:app --reload
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import auth, health, projects, users
from app.core.config import BASE_DIR, VERSION, Settings
from app.core.errors import install_error_handlers
from app.core.rate_limit import RateLimiter
from app.core.request_log import configure_logging, install_request_logging
from app.db.database import Database
from app.db.migrations import migrate


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    configure_logging(settings.log_level)
    db = Database(settings.database_url, base_dir=BASE_DIR)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        migrate(db)
        yield

    app = FastAPI(
        title=settings.app_name,
        version=VERSION,
        lifespan=lifespan,
        # The interactive docs stay on in development; turn them off in production.
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.db = db
    app.state.login_limiter = RateLimiter(settings.login_attempts, settings.login_window_seconds)

    install_error_handlers(app)
    install_request_logging(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )

    for module in (health, auth, users, projects):
        app.include_router(module.router)
    return app


app = create_app()
