"""Pydantic request/response schemas mirroring contracts/openapi.yaml."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

EntryType = Literal["feed", "sleep", "poop", "appointment"]
FeedType = Literal["breast_milk", "formula", "solids", "water"]
FeedUnit = Literal["ml", "g"]
PoopConsistency = Literal["watery", "soft", "formed", "hard"]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ---------------------------------------------------------------------------
# Request / response envelopes
# ---------------------------------------------------------------------------


class AgentWriteRequest(_StrictModel):
    message: Annotated[str, Field(min_length=1, max_length=2000)]
    entry_id: int | None = None
    entry_type: EntryType | None = None
    correlation_id: str | None = None


class SuggestedCandidate(_StrictModel):
    entry_type: EntryType
    entry_id: int
    summary: str


class AgentClarificationResponse(_StrictModel):
    outcome: Literal["clarification_requested"]
    agent_message: str
    suggested_candidates: list[SuggestedCandidate] | None = None
    correlation_id: str
    session_id: str


class ErrorResponse(_StrictModel):
    error: str
    message: str
    details: dict[str, object] | None = None
    correlation_id: str
    session_id: str | None = None


# ---------------------------------------------------------------------------
# Entry payloads (GET responses + AgentWriteResponse.entry)
# ---------------------------------------------------------------------------


class FeedEntry(_StrictModel):
    id: int
    entry_type: Literal["feed"] = "feed"
    feed_type: FeedType
    quantity: Annotated[float, Field(gt=0)]
    unit: FeedUnit
    occurred_at: datetime
    created_at: datetime
    updated_at: datetime


class SleepEntry(_StrictModel):
    id: int
    entry_type: Literal["sleep"] = "sleep"
    start_at: datetime
    end_at: datetime
    duration_minutes: Annotated[int, Field(ge=1)]
    created_at: datetime
    updated_at: datetime


class PoopEntry(_StrictModel):
    id: int
    entry_type: Literal["poop"] = "poop"
    occurred_at: datetime
    consistency: PoopConsistency
    created_at: datetime
    updated_at: datetime


class AppointmentNote(_StrictModel):
    id: int
    body: Annotated[str, Field(min_length=1, max_length=2000)]
    added_at: datetime


class AppointmentEntry(_StrictModel):
    id: int
    entry_type: Literal["appointment"] = "appointment"
    scheduled_at: datetime
    notes: list[AppointmentNote] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


EntryPayload = FeedEntry | SleepEntry | PoopEntry | AppointmentEntry


class AgentWriteResponse(_StrictModel):
    outcome: Literal["created", "updated", "deleted"]
    entry_type: EntryType
    entry: EntryPayload
    agent_message: str | None = None
    correlation_id: str
    session_id: str


# ---------------------------------------------------------------------------
# GET-by-date list envelopes
# ---------------------------------------------------------------------------


class FeedListResponse(_StrictModel):
    date: str
    items: list[FeedEntry]


class SleepListResponse(_StrictModel):
    date: str
    items: list[SleepEntry]


class PoopListResponse(_StrictModel):
    date: str
    items: list[PoopEntry]


class AppointmentListResponse(_StrictModel):
    date: str
    items: list[AppointmentEntry]


# ---------------------------------------------------------------------------
# Feature 005 — Direct-LLM Chat Entry (`POST /v1/chatentry/`)
# ---------------------------------------------------------------------------


ChatEntryOutcome = Literal[
    "created", "updated", "deleted", "clarification_requested", "error"
]
ChatEntryErrorReason = Literal[
    "malformed_llm_output",
    "unknown_tool",
    "invalid_tool_arguments",
    "tool_execution_failed",
    "llm_unavailable",
    "validation_error",
]


class ChatHistoryTurn(_StrictModel):
    """A prior turn supplied by the client when no `X-Session-ID` resolves."""

    role: Literal["caregiver", "assistant"]
    text: Annotated[str, Field(min_length=1, max_length=8192)]
    outcome: ChatEntryOutcome | None = None
    entry_type: EntryType | None = None
    entry_id: int | None = None


class ChatEntryRequest(_StrictModel):
    """`POST /v1/chatentry/` request body."""

    message: Annotated[str, Field(min_length=1, max_length=8192)]
    history: list[ChatHistoryTurn] = Field(default_factory=list)
    correlation_id: str | None = None


class ChatEntryResponse(_StrictModel):
    """`POST /v1/chatentry/` response body."""

    outcome: ChatEntryOutcome
    agent_message: str
    entry_type: EntryType | None = None
    entry_id: int | None = None
    selected_tool: str | None = None
    error_reason: ChatEntryErrorReason | None = None
    suggested_candidates: list[SuggestedCandidate] | None = None
    correlation_id: str
    session_id: str


# ---------------------------------------------------------------------------
# `LLMDecision` — the structured output the LLM must return. Discriminated
# union keyed by `kind`. Validated on every request; any deviation yields
# outcome="error" with reason="malformed_llm_output".
# ---------------------------------------------------------------------------


class LLMToolCallDecision(_StrictModel):
    kind: Literal["tool_call"]
    tool_name: Annotated[str, Field(min_length=1)]
    arguments: dict[str, object] = Field(default_factory=dict)


class LLMClarificationDecision(_StrictModel):
    kind: Literal["clarification"]
    question: Annotated[str, Field(min_length=1, max_length=500)]
    suggested_candidates: list[SuggestedCandidate] | None = None


LLMDecision = LLMToolCallDecision | LLMClarificationDecision

