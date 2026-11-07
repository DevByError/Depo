"""Settings from the environment (and an optional .env file). The only place that reads them."""

from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("app.config")

APP_NAME = __DEPO_PY_NAME__
VERSION = "0.1.0"
BASE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


def load_dotenv(path: Path) -> None:
    """Read KEY=VALUE lines into the environment. Variables that are already set win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _list(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


def _dev_secret() -> str:
    """A generated secret kept in data/.dev-secret, so sign-ins survive a restart in development."""
    path = BASE_DIR / "data" / ".dev-secret"
    try:
        saved = path.read_text(encoding="utf-8").strip()
        if len(saved) >= 32:
            return saved
    except OSError:
        pass
    secret = secrets.token_urlsafe(48)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secret, encoding="utf-8")
    except OSError:
        log.warning("Could not save data/.dev-secret: sign-ins end when the server restarts.")
    return secret


@dataclass(frozen=True)
class Settings:
    app_name: str = APP_NAME
    environment: str = "development"
    database_url: str = "sqlite:///data/app.db"
    jwt_secret: str = ""
    jwt_algorithm: str = "HS256"
    token_minutes: int = 60
    cors_origins: list[str] = field(default_factory=lambda: _list(DEFAULT_ORIGINS))
    log_level: str = "INFO"
    login_attempts: int = 5
    login_window_seconds: int = 300

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @classmethod
    def from_env(cls) -> Settings:
        load_dotenv(BASE_DIR / ".env")
        env = os.environ.get
        environment = env("APP_ENV", "development").strip().lower()
        secret = env("JWT_SECRET", "").strip()
        if len(secret) < 32:
            if environment == "production":
                raise RuntimeError("Set JWT_SECRET to at least 32 random characters before running in production.")
            log.info("JWT_SECRET is not set: using the development secret in data/.dev-secret.")
            secret = _dev_secret()
        return cls(
            app_name=env("APP_NAME", APP_NAME),
            environment=environment,
            database_url=env("DATABASE_URL", "sqlite:///data/app.db"),
            jwt_secret=secret,
            token_minutes=int(env("TOKEN_MINUTES", "60")),
            cors_origins=_list(env("CORS_ORIGINS", DEFAULT_ORIGINS)),
            log_level=env("LOG_LEVEL", "INFO").strip().upper(),
            login_attempts=int(env("LOGIN_ATTEMPTS", "5")),
            login_window_seconds=int(env("LOGIN_WINDOW_SECONDS", "300")),
        )
