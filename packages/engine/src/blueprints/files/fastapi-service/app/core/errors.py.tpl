"""One error format for every response: {"error": {"code", "message", "details", "request_id"}}."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("app.errors")


class AppError(Exception):
    """Raise a subclass from services and routes; the handler turns it into the JSON error."""

    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, details: list[dict[str, Any]] | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or []


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"


class NotFound(AppError):
    status_code = 404
    code = "not_found"


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class TooManyRequests(AppError):
    status_code = 429
    code = "too_many_requests"


HTTP_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    422: "validation_error",
    429: "too_many_requests",
}


def request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


def error_body(code: str, message: str, details: list[dict[str, Any]], rid: str | None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message, "details": details}
    if rid:
        error["request_id"] = rid
    return {"error": error}


def _field(loc: tuple[Any, ...] | list[Any]) -> str:
    parts = [str(p) for p in loc if p not in ("body", "query", "path", "header", "cookie")]
    return ".".join(parts) or "request"


def _message(error: dict[str, Any]) -> str:
    msg = str(error.get("msg", "This value is not valid."))
    return msg.removeprefix("Value error, ")


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else None
        body = error_body(exc.code, exc.message, exc.details, request_id(request))
        return JSONResponse(body, status_code=exc.status_code, headers=headers)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        message = exc.detail if isinstance(exc.detail, str) else "The request failed."
        body = error_body(HTTP_CODES.get(exc.status_code, "error"), message, [], request_id(request))
        return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"field": _field(e.get("loc", ())), "message": _message(e)} for e in exc.errors()]
        body = error_body("validation_error", "Some fields are not valid.", details, request_id(request))
        return JSONResponse(body, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error (request %s)", request_id(request))
        message = "Something went wrong on our side. Try again later."
        return JSONResponse(error_body("internal_error", message, [], request_id(request)), status_code=500)
