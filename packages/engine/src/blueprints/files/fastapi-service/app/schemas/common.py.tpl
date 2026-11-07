"""Shapes shared by many routes."""

from __future__ import annotations

import math
from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")

MAX_PAGE_SIZE = 100


class Page(BaseModel, Generic[T]):
    """One page of a list. Every list endpoint returns this shape."""

    items: list[T]
    total: int
    page: int
    page_size: int
    pages: int

    @classmethod
    def of(cls, items: list[T], total: int, page: int, page_size: int) -> Page[T]:
        return cls(items=items, total=total, page=page, page_size=page_size, pages=math.ceil(total / page_size))
