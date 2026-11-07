"""What the auth and user routes accept and return."""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

Role = Literal["user", "admin"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


def _email(value: str) -> str:
    value = value.strip().lower()
    if not EMAIL.match(value):
        raise ValueError("Enter a valid email address, like name@example.com.")
    return value


class SignUpIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(max_length=254)
    # Passwords are never stripped or logged.
    password: str = Field(min_length=8, max_length=128)
    name: Name

    _valid_email = field_validator("email")(_email)


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=128)

    _valid_email = field_validator("email")(_email)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: Role
    created_at: str


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserOut


class RoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role
