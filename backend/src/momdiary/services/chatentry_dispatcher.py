"""Direct-LLM chat-entry dispatcher (feature 005).

This module is the heart of `POST /v1/chatentry/`. It does NOT use the
Microsoft Agent Framework `Agent` / `ChatAgent` runtime (FR-003). It
calls the underlying chat-completion model directly via
`agent_framework.azure.AzureOpenAIChatClient` (an MAF primitive — Principle V),
forces a JSON-schema response describing exactly one of two decisions
(`tool_call` or `clarification`), and dispatches the chosen tool against
the same registry used by `/v1/entries`.

Single LLM round-trip per request. No agent loop, no implicit retries.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any, Protocol

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from momdiary.agents.dispatcher import AgentRunResult
from momdiary.agents.session_store import ChatSession, ChatTurn, SessionStore
from momdiary.agents.tools.registry import invoke_tool
from momdiary.config import Settings
from momdiary.models.schemas import (
    ChatEntryRequest,
    ChatEntryResponse,
    ChatHistoryTurn,
    LLMClarificationDecision,
    LLMToolCallDecision,
)
from momdiary.observability.logging import get_logger
from momdiary.services.chatentry_catalog import (
    ToolDescriptor,
    args_model_for,
    build_tool_catalog,
    catalog_for_prompt,
    catalog_tool_names,
)
from momdiary.services.time_service import get_default_timezone

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Errors — internal, mapped to ChatEntryResponse(outcome="error", error_reason=...)
# ---------------------------------------------------------------------------


class DispatcherError(Exception):
    """Base error type. Subclasses carry the typed error_reason."""

    error_reason: str = "tool_execution_failed"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class MalformedLLMOutputError(DispatcherError):
    error_reason = "malformed_llm_output"


class UnknownToolError(DispatcherError):
    error_reason = "unknown_tool"


class InvalidToolArgumentsError(DispatcherError):
    error_reason = "invalid_tool_arguments"


class LLMUnavailableError(DispatcherError):
    error_reason = "llm_unavailable"


# ---------------------------------------------------------------------------
# Chat-client protocol (Principle IV: substitutable seam for tests)
# ---------------------------------------------------------------------------


class ChatClientProtocol(Protocol):
    """Minimal interface the dispatcher needs from a chat client.

    Implementations MUST return the LLM's structured-output JSON as a
    plain Python `dict` — already parsed. The dispatcher does not parse
    raw text. This keeps the protocol model-portable: any backend that
    can produce a JSON object satisfying the supplied schema works.
    """

    async def get_response(
        self,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any],
    ) -> dict[str, Any]: ...


# ---------------------------------------------------------------------------
# Real chat-client adapter wrapping the MAF AzureOpenAIChatClient
# ---------------------------------------------------------------------------


def _build_chatentry_chat_client() -> ChatClientProtocol:  # pragma: no cover - I/O
    """Construct the production chat client.

    Uses `openai.AsyncAzureOpenAI` directly with Entra ID auth via
    `DefaultAzureCredential`. This endpoint deliberately does NOT route
    through the Microsoft Agent Framework (FR-003) — it is a one-shot
    JSON-schema dispatcher, so the raw OpenAI SDK is the right layer.
    The `/v1/entries` agent path is unaffected (FR-012).
    """
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider
    from openai import AsyncAzureOpenAI

    from momdiary.config import get_settings

    settings = get_settings()
    token_provider = get_bearer_token_provider(
        DefaultAzureCredential(),
        "https://cognitiveservices.azure.com/.default",
    )
    client = AsyncAzureOpenAI(
        azure_endpoint=settings.azure_openai_endpoint,
        azure_ad_token_provider=token_provider,
        api_version=settings.azure_openai_api_version,
    )
    deployment = settings.azure_openai_deployment

    class _AzureAdapter:
        async def get_response(
            self,
            *,
            messages: list[dict[str, str]],
            response_format: dict[str, Any],
        ) -> dict[str, Any]:
            started = time.perf_counter()
            logger.info(
                "chatentry.llm.request",
                deployment=deployment,
                message_count=len(messages),
                last_user_preview=(
                    (messages[-1].get("content") or "")[:200]
                    if messages
                    else ""
                ),
                response_format_name=(
                    response_format.get("json_schema", {}).get("name")
                ),
            )
            logger.debug(
                "chatentry.llm.request.full",
                messages=messages,
                response_format=response_format,
            )
            try:
                completion = await client.chat.completions.create(
                    model=deployment,
                    messages=messages,
                    response_format=response_format,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "chatentry.llm.failed",
                    deployment=deployment,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    error=str(exc),
                    error_type=type(exc).__name__,
                )
                raise
            text = completion.choices[0].message.content or ""
            usage = getattr(completion, "usage", None)
            logger.info(
                "chatentry.llm.response",
                deployment=deployment,
                duration_ms=int((time.perf_counter() - started) * 1000),
                finish_reason=completion.choices[0].finish_reason,
                prompt_tokens=getattr(usage, "prompt_tokens", None),
                completion_tokens=getattr(usage, "completion_tokens", None),
                total_tokens=getattr(usage, "total_tokens", None),
                content_length=len(text),
            )
            logger.debug("chatentry.llm.response.full", content=text)
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                raise MalformedLLMOutputError(
                    f"LLM did not return valid JSON: {exc}"
                ) from exc

    return _AzureAdapter()


# ---------------------------------------------------------------------------
# System prompt (T023)
# ---------------------------------------------------------------------------


SYSTEM_PROMPT_TEMPLATE = """\
You are MomDiary's direct-LLM chat-entry dispatcher. Each request is a
single round-trip: read the caregiver's message, optionally consult the
prior turns, then return EXACTLY ONE structured decision in JSON.

# Decision shape

You MUST return a JSON object matching exactly one of these two shapes:

1) Call a tool:
   {{"kind": "tool_call", "tool_name": "<one of the tool names below>",
     "arguments": {{ ...arguments matching the tool's schema... }}}}

2) Ask for clarification (use ONLY when the caregiver's intent is
   genuinely ambiguous — missing quantity, missing antecedent for "it"/
   "that", or unable to choose among feed/sleep/poop/appointment):
   {{"kind": "clarification",
     "question": "<one focused question for the caregiver>",
     "suggested_candidates": [...optional, omit if not applicable...]}}

NEVER emit free-form text. NEVER call more than one tool. NEVER invent
`entry_id` values — they must come from the supplied conversation
history. If the prior turn confirmed an entry id and the caregiver now
says "it"/"that"/"actually …", reuse that id with the matching update_*
or delete_* tool.

# Available tools

{tool_catalog_json}

# Canonical vocabulary (normalize BEFORE emitting the tool call)

- feed_type ∈ {{"breast_milk", "formula", "solids", "water"}}.
  Map "breastmilk"/"bm"/"milk"/"breast" → "breast_milk"; "form" →
  "formula"; "food"/"solid"/"purée"/"puree" → "solids".
- unit ∈ {{"ml", "g"}}. Convert ounces (oz / fl oz) using
  1 oz = 29.5735 ml, rounded to 2 decimals. Never pass "oz".
- consistency ∈ {{"watery", "soft", "formed", "hard"}}.
  "runny" → "watery"; "mushy"/"normal"/"regular"/"typical" → "soft";
  "solid"/"log" → "formed"; "dry"/"pellets" → "hard". Default to "soft"
  if the caregiver does not mention consistency at all.

# Time handling

- The user message is prefixed with `Current local time: <ISO> (<TZ>)`.
  Use that as "now" for relative phrasings.
- All occurred_at / start_at / end_at / scheduled_at values MUST be
  ISO-8601 with the matching timezone offset.
- "just now" / "now" → current local time.
- "30 min ago" / "an hour ago" → subtract from current local time.
- For sleeps, end_at MUST be strictly after start_at.

# Hard rules

- The "tool_name" you emit MUST be one of the names listed above. Any
  other value is malformed and will be rejected without a database
  write.
- The "arguments" object MUST validate against the tool's schema —
  unknown keys, wrong types, or missing required fields are malformed.
- If you cannot proceed safely, emit a clarification decision instead
  of guessing.
"""


def _render_system_prompt(catalog: list[ToolDescriptor]) -> str:
    catalog_json = json.dumps(catalog_for_prompt(catalog), indent=2)
    return SYSTEM_PROMPT_TEMPLATE.format(tool_catalog_json=catalog_json)


# ---------------------------------------------------------------------------
# History sourcing (T013)
# ---------------------------------------------------------------------------


def _from_session_turns(turns: list[ChatTurn]) -> list[ChatHistoryTurn]:
    """Project session-store ChatTurns to the request-shape ChatHistoryTurn."""
    out: list[ChatHistoryTurn] = []
    for t in turns:
        outcome = t.outcome
        # The session store uses "rejected" for tool-failure outcomes; the
        # ChatHistoryTurn enum collapses that to "error" for the LLM.
        if outcome == "rejected":
            outcome = "error"
        out.append(
            ChatHistoryTurn(
                role=t.role,
                text=t.text,
                outcome=outcome,  # type: ignore[arg-type]
                entry_type=t.entry_type,  # type: ignore[arg-type]
                entry_id=t.entry_id,
            )
        )
    return out


async def resolve_history(
    *,
    chat_session: ChatSession,
    request_history: list[ChatHistoryTurn],
    store: SessionStore,
    settings: Settings,
) -> list[ChatHistoryTurn]:
    """Choose between server-side session history and request-supplied history.

    Per research.md §3: server-side history (feature-003 SessionStore) wins
    when it resolves and is non-empty; otherwise the request body's
    `history` is used as-is. The dispatcher itself trims later when
    assembling the prompt.
    """
    server_turns = await store.recent_view(
        chat_session,
        token_budget=settings.momdiary_session_prompt_token_budget,
    )
    if server_turns:
        return _from_session_turns(server_turns)
    return list(request_history)


# ---------------------------------------------------------------------------
# Prompt assembly (T011) — pure function, no I/O.
# ---------------------------------------------------------------------------


def _estimate_tokens(text: str) -> int:
    return (len(text) // 4) + 4


def _trim_history_oldest_first(
    history: list[ChatHistoryTurn], remaining_budget: int
) -> list[ChatHistoryTurn]:
    """Drop oldest turns until the running token budget fits."""
    if remaining_budget <= 0 or not history:
        return []
    # Walk from newest to oldest, keeping turns that fit.
    kept_reversed: list[ChatHistoryTurn] = []
    used = 0
    for turn in reversed(history):
        cost = _estimate_tokens(turn.text)
        if used + cost > remaining_budget:
            break
        kept_reversed.append(turn)
        used += cost
    kept_reversed.reverse()
    return kept_reversed


def assemble_prompt(
    *,
    message: str,
    history: list[ChatHistoryTurn],
    catalog: list[ToolDescriptor],
    settings: Settings,
    now_local: datetime,
    timezone_name: str,
) -> list[dict[str, str]]:
    """Build the messages list for the chat-completion call.

    Layout:
      - SYSTEM: instructions + tool catalog JSON.
      - USER (history turns): prior caregiver / assistant text, oldest-first
        trim if the prompt would exceed the configured token budget.
      - USER (current turn): time-prefixed caregiver message.
    """
    system_prompt = _render_system_prompt(catalog)
    system_cost = _estimate_tokens(system_prompt)
    current_block = (
        f"Current local time: {now_local.isoformat(timespec='seconds')} "
        f"({timezone_name}).\n\nCaregiver: {message}"
    )
    current_cost = _estimate_tokens(current_block)
    remaining = settings.momdiary_session_prompt_token_budget - system_cost - current_cost
    fitted_history = _trim_history_oldest_first(history, remaining)

    messages: list[dict[str, str]] = [
        {"role": "system", "content": system_prompt},
    ]
    for turn in fitted_history:
        role = "user" if turn.role == "caregiver" else "assistant"
        text = turn.text
        if (
            turn.role == "assistant"
            and turn.outcome in {"created", "updated", "deleted"}
            and turn.entry_type
            and turn.entry_id is not None
        ):
            text = f"{text} (recorded: {turn.outcome} {turn.entry_type}#{turn.entry_id})"
        messages.append({"role": role, "content": text})
    messages.append({"role": "user", "content": current_block})
    return messages


# ---------------------------------------------------------------------------
# Response-format builder (T012 input)
# ---------------------------------------------------------------------------


def build_response_format(catalog: list[ToolDescriptor]) -> dict[str, Any]:
    """Build the `response_format` argument for the LLM call.

    Azure OpenAI's structured-output validator rejects any top-level
    union construct (`anyOf` / `oneOf` / `allOf` / `enum` / `not`).
    We therefore emit a single flat object whose discriminator is
    `kind` and whose other fields are optional. The dispatcher's
    `parse_llm_decision` then enforces the discriminated union
    server-side (FR-005, FR-013) so the LLM cannot smuggle a
    nonsense combination through.
    """
    tool_names = catalog_tool_names(catalog)
    schema = {
        "name": "MomDiaryChatEntryDecision",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind"],
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["tool_call", "clarification"],
                },
                "tool_name": {
                    "type": "string",
                    "enum": tool_names,
                    "description": (
                        "Required when kind=='tool_call'. Must be one of"
                        " the live tool names."
                    ),
                },
                "arguments": {
                    "type": "object",
                    "description": (
                        "Required when kind=='tool_call'. Arguments for"
                        " the chosen tool; shape varies per tool."
                    ),
                },
                "question": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500,
                    "description": (
                        "Required when kind=='clarification'. The"
                        " caregiver-facing question to ask."
                    ),
                },
                "suggested_candidates": {
                    "type": "array",
                    "description": (
                        "Optional when kind=='clarification'. Candidate"
                        " entries the caregiver might have meant."
                    ),
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["entry_type", "entry_id", "summary"],
                        "properties": {
                            "entry_type": {
                                "type": "string",
                                "enum": [
                                    "feed",
                                    "sleep",
                                    "poop",
                                    "appointment",
                                ],
                            },
                            "entry_id": {"type": "integer"},
                            "summary": {"type": "string"},
                        },
                    },
                },
            },
        },
        # `strict: false` because (a) the union is enforced server-side
        # via `parse_llm_decision` and (b) `arguments` is intentionally
        # open (its shape varies per tool and is re-validated against
        # the tool's Pydantic args model). Strict mode would require
        # inlining every per-tool schema (FR-005, FR-013).
        "strict": False,
    }
    return {"type": "json_schema", "json_schema": schema}


# ---------------------------------------------------------------------------
# Decision parsing (T012)
# ---------------------------------------------------------------------------


def parse_llm_decision(
    raw: dict[str, Any], catalog: list[ToolDescriptor]
) -> LLMToolCallDecision | LLMClarificationDecision:
    """Validate the raw LLM JSON against the dispatcher's decision shape.

    Raises `MalformedLLMOutputError`, `UnknownToolError`, or
    `InvalidToolArgumentsError` — never returns invalid data.
    """
    if not isinstance(raw, dict):
        raise MalformedLLMOutputError("LLM response is not a JSON object.")
    kind = raw.get("kind")
    if kind == "tool_call":
        try:
            decision = LLMToolCallDecision.model_validate(raw)
        except ValidationError as exc:
            raise MalformedLLMOutputError(
                f"tool_call decision failed shape validation: {exc.errors()}"
            ) from exc
        names = set(catalog_tool_names(catalog))
        if decision.tool_name not in names:
            raise UnknownToolError(
                f"Tool '{decision.tool_name}' is not in the live catalog."
            )
        # Re-validate arguments against the tool's existing Pydantic args
        # model so the dispatcher refuses to invoke a tool with malformed
        # parameters even if the JSON-schema response_format slipped.
        if decision.tool_name == "ask_for_clarification":
            # The synthetic tool is handled via the `clarification` kind
            # below; if the model picked it as a tool_call instead, treat
            # the `arguments.question` / `arguments.suggested_candidates`
            # as a clarification.
            try:
                return LLMClarificationDecision(
                    kind="clarification",
                    question=str(decision.arguments.get("question", "")),
                    suggested_candidates=decision.arguments.get(
                        "suggested_candidates"
                    ),
                )
            except ValidationError as exc:
                raise MalformedLLMOutputError(
                    f"ask_for_clarification arguments invalid: {exc.errors()}"
                ) from exc
        args_model = args_model_for(decision.tool_name)
        if args_model is not None:
            try:
                args_model.model_validate(decision.arguments)
            except ValidationError as exc:
                raise InvalidToolArgumentsError(
                    f"Arguments for '{decision.tool_name}' failed validation: "
                    f"{exc.errors()}"
                ) from exc
        return decision
    if kind == "clarification":
        try:
            return LLMClarificationDecision.model_validate(raw)
        except ValidationError as exc:
            raise MalformedLLMOutputError(
                f"clarification decision failed shape validation: {exc.errors()}"
            ) from exc
    raise MalformedLLMOutputError(f"Unknown LLM decision kind: {kind!r}")


# ---------------------------------------------------------------------------
# Tool dispatch (T019, T029, T036)
# ---------------------------------------------------------------------------


_OUTCOME_TO_RESPONSE: dict[str, str] = {
    "created": "created",
    "updated": "updated",
    "deleted": "deleted",
}


async def _dispatch_tool_call(
    decision: LLMToolCallDecision,
    *,
    db_session: AsyncSession,
    correlation_id: str,
    session_id: str,
) -> ChatEntryResponse:
    """Invoke the chosen tool through the shared registry."""
    try:
        result: AgentRunResult = await invoke_tool(
            decision.tool_name, db_session, **decision.arguments
        )
    except KeyError as exc:
        raise UnknownToolError(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "chatentry.tool_failed",
            correlation_id=correlation_id,
            tool=decision.tool_name,
        )
        raise DispatcherError(f"Tool '{decision.tool_name}' raised: {exc}") from exc

    if result.outcome == "rejected":
        # The repository couldn't find the target row (or similar
        # validation failure). Surface as an error outcome — the LLM
        # picked a target that no longer exists.
        return ChatEntryResponse(
            outcome="error",
            error_reason="tool_execution_failed",
            agent_message=result.agent_message or "Tool rejected the request.",
            selected_tool=decision.tool_name,
            entry_type=result.entry_type,  # type: ignore[arg-type]
            correlation_id=correlation_id,
            session_id=session_id,
        )

    outcome = _OUTCOME_TO_RESPONSE.get(result.outcome)
    if outcome is None:
        # invoke_tool returned an unexpected outcome — defensive.
        raise DispatcherError(
            f"Tool '{decision.tool_name}' returned unexpected outcome "
            f"{result.outcome!r}."
        )
    # Persist the write; the per-request session is otherwise rolled back
    # when the FastAPI dependency exits. Mirrors `AgentDispatcher.dispatch`.
    await db_session.commit()
    return ChatEntryResponse(
        outcome=outcome,  # type: ignore[arg-type]
        agent_message=result.agent_message or f"{outcome} {result.entry_type}.",
        entry_type=result.entry_type,  # type: ignore[arg-type]
        entry_id=result.entry_id,
        selected_tool=decision.tool_name,
        correlation_id=correlation_id,
        session_id=session_id,
    )


def _clarification_response(
    decision: LLMClarificationDecision,
    *,
    correlation_id: str,
    session_id: str,
) -> ChatEntryResponse:
    return ChatEntryResponse(
        outcome="clarification_requested",
        agent_message=decision.question,
        suggested_candidates=decision.suggested_candidates,
        selected_tool="ask_for_clarification",
        correlation_id=correlation_id,
        session_id=session_id,
    )


# ---------------------------------------------------------------------------
# End-to-end pipeline (T020)
# ---------------------------------------------------------------------------


async def run_chatentry(
    request: ChatEntryRequest,
    *,
    db_session: AsyncSession,
    chat_client: ChatClientProtocol,
    chat_session: ChatSession,
    store: SessionStore,
    settings: Settings,
    correlation_id: str,
) -> ChatEntryResponse:
    """Execute a single direct-LLM chatentry request end-to-end."""
    handler_started = time.perf_counter()
    catalog = build_tool_catalog()
    history = await resolve_history(
        chat_session=chat_session,
        request_history=request.history,
        store=store,
        settings=settings,
    )
    tz = await get_default_timezone(db_session)
    now_local = datetime.now(tz)
    messages = assemble_prompt(
        message=request.message,
        history=history,
        catalog=catalog,
        settings=settings,
        now_local=now_local,
        timezone_name=tz.key,
    )
    response_format = build_response_format(catalog)

    logger.info(
        "chatentry.dispatch",
        correlation_id=correlation_id,
        session_id=chat_session.id,
        tool_count=len(catalog),
        history_turns=len(history),
        message_len=len(request.message),
    )

    llm_started = time.perf_counter()
    try:
        raw_decision = await chat_client.get_response(
            messages=messages, response_format=response_format
        )
    except (TimeoutError, ConnectionError) as exc:
        llm_ms = int((time.perf_counter() - llm_started) * 1000)
        logger.warning(
            "chatentry.llm_unavailable",
            correlation_id=correlation_id,
            session_id=chat_session.id,
            llm_latency_ms=llm_ms,
            error=str(exc),
        )
        return ChatEntryResponse(
            outcome="error",
            error_reason="llm_unavailable",
            agent_message="The LLM is temporarily unavailable. Please try again.",
            correlation_id=correlation_id,
            session_id=chat_session.id,
        )
    except MalformedLLMOutputError as exc:
        llm_ms = int((time.perf_counter() - llm_started) * 1000)
        logger.warning(
            "chatentry.malformed_llm_output",
            correlation_id=correlation_id,
            session_id=chat_session.id,
            llm_latency_ms=llm_ms,
            error=exc.message,
        )
        return ChatEntryResponse(
            outcome="error",
            error_reason="malformed_llm_output",
            agent_message="The LLM returned an unexpected response.",
            correlation_id=correlation_id,
            session_id=chat_session.id,
        )
    except Exception as exc:  # noqa: BLE001
        llm_ms = int((time.perf_counter() - llm_started) * 1000)
        logger.exception(
            "chatentry.llm_call_failed",
            correlation_id=correlation_id,
            session_id=chat_session.id,
            llm_latency_ms=llm_ms,
        )
        return ChatEntryResponse(
            outcome="error",
            error_reason="llm_unavailable",
            agent_message=f"LLM call failed: {exc}",
            correlation_id=correlation_id,
            session_id=chat_session.id,
        )
    llm_ms = int((time.perf_counter() - llm_started) * 1000)

    try:
        decision = parse_llm_decision(raw_decision, catalog)
    except DispatcherError as exc:
        logger.warning(
            "chatentry.decision_invalid",
            correlation_id=correlation_id,
            session_id=chat_session.id,
            error_reason=exc.error_reason,
            error=exc.message,
        )
        return ChatEntryResponse(
            outcome="error",
            error_reason=exc.error_reason,  # type: ignore[arg-type]
            agent_message=exc.message,
            correlation_id=correlation_id,
            session_id=chat_session.id,
        )

    if isinstance(decision, LLMClarificationDecision):
        response = _clarification_response(
            decision,
            correlation_id=correlation_id,
            session_id=chat_session.id,
        )
    else:
        try:
            response = await _dispatch_tool_call(
                decision,
                db_session=db_session,
                correlation_id=correlation_id,
                session_id=chat_session.id,
            )
        except DispatcherError as exc:
            response = ChatEntryResponse(
                outcome="error",
                error_reason=exc.error_reason,  # type: ignore[arg-type]
                agent_message=exc.message,
                selected_tool=decision.tool_name,
                correlation_id=correlation_id,
                session_id=chat_session.id,
            )

    handler_ms = int((time.perf_counter() - handler_started) * 1000)
    logger.info(
        "chatentry.completed",
        correlation_id=correlation_id,
        session_id=chat_session.id,
        outcome=response.outcome,
        error_reason=response.error_reason,
        selected_tool=response.selected_tool,
        entry_type=response.entry_type,
        entry_id=response.entry_id,
        llm_latency_ms=llm_ms,
        handler_latency_ms=handler_ms,
    )
    return response


__all__ = [
    "ChatClientProtocol",
    "DispatcherError",
    "InvalidToolArgumentsError",
    "LLMUnavailableError",
    "MalformedLLMOutputError",
    "SYSTEM_PROMPT_TEMPLATE",
    "UnknownToolError",
    "_build_chatentry_chat_client",
    "assemble_prompt",
    "build_response_format",
    "parse_llm_decision",
    "resolve_history",
    "run_chatentry",
]
