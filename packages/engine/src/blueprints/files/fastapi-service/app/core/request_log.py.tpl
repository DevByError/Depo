"""Logging: one line per request with its id. Never log bodies, passwords or tokens."""

from __future__ import annotations

import logging
import re
import time
import uuid

from fastapi import FastAPI, Request

log = logging.getLogger("app.requests")
SAFE_ID = re.compile(r"[A-Za-z0-9._-]{8,64}")


def configure_logging(level: str) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("app").setLevel(level)


def install_request_logging(app: FastAPI) -> None:
    @app.middleware("http")
    async def log_requests(request: Request, call_next):  # type: ignore[no-untyped-def]
        incoming = request.headers.get("x-request-id", "")
        rid = incoming if SAFE_ID.fullmatch(incoming) else uuid.uuid4().hex[:16]
        request.state.request_id = rid
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
        finally:
            ms = (time.perf_counter() - started) * 1000
            # The path only: query strings can carry personal data.
            log.info("%s %s %s %.1fms id=%s", request.method, request.url.path, status, ms, rid)
        response.headers["X-Request-ID"] = rid
        return response
