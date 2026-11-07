"""Small helpers for repositories."""

from __future__ import annotations

from datetime import datetime, timezone


def now() -> str:
    """The current time in UTC as ISO 8601 text (sorts correctly and works in every database)."""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def like_pattern(text: str) -> str:
    """A LIKE pattern that matches `text` anywhere, with % and _ in it taken literally (ESCAPE '\\')."""
    escaped = text.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"
