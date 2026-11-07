"""A small sliding-window limiter for failed sign-ins (in memory, so per process).

Run one worker, or move the counts to Redis when you run several.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable


class RateLimiter:
    def __init__(self, attempts: int, window_seconds: int, clock: Callable[[], float] = time.monotonic):
        self.attempts = attempts
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str) -> deque[float]:
        hits = self._hits.setdefault(key, deque())
        cutoff = self._clock() - self.window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        return hits

    def retry_after(self, key: str) -> int:
        """Seconds to wait before trying again; 0 when allowed."""
        with self._lock:
            hits = self._recent(key)
            if len(hits) < self.attempts:
                return 0
            return max(1, int(hits[0] + self.window - self._clock()) + 1)

    def fail(self, key: str) -> None:
        with self._lock:
            self._recent(key).append(self._clock())

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)
