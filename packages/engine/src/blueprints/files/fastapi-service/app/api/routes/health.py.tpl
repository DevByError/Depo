"""Health check for monitors and load balancers. No sign-in needed."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.config import VERSION

router = APIRouter(tags=["health"])
log = logging.getLogger("app.health")


@router.get("/api/health")
def health(request: Request) -> JSONResponse:
    try:
        with request.app.state.db.session() as conn:
            conn.scalar("SELECT 1")
        database = "ok"
    except Exception:
        log.exception("database check failed")
        database = "unavailable"
    ok = database == "ok"
    body = {"status": "ok" if ok else "degraded", "database": database, "version": VERSION}
    return JSONResponse(body, status_code=200 if ok else 503)
