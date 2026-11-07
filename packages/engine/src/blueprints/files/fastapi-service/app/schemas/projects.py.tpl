"""What the project routes accept and return. Copy this file for a new resource."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Status = Literal["active", "paused", "done"]
Sort = Literal["name", "-name", "created_at", "-created_at", "updated_at", "-updated_at"]
ProjectName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class ProjectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ProjectName
    description: str = Field(default="", max_length=2000)
    status: Status = "active"


class ProjectUpdate(BaseModel):
    """Every field is optional; send only what changes."""

    model_config = ConfigDict(extra="forbid")

    name: ProjectName | None = None
    description: str | None = Field(default=None, max_length=2000)
    status: Status | None = None

    @model_validator(mode="after")
    def something_changes(self) -> ProjectUpdate:
        if not self.model_fields_set:
            raise ValueError("Send at least one field to change.")
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null.")
        return self

    def changes(self) -> dict[str, object]:
        return self.model_dump(include=self.model_fields_set)


class ProjectOut(BaseModel):
    id: int
    owner_id: int
    name: str
    description: str
    status: Status
    created_at: str
    updated_at: str
