"""Adapter that runs the real MAF Agent and normalizes its output.

Each request builds a fresh `Agent` with tool wrappers that close over the
caller's `AsyncSession`. Tool wrappers call the shared `invoke_tool`
registry so production and scripted tests share one execution path.
"""

from __future__ import annotations

import inspect
import json
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from momdiary.agents.diary_agent import build_agent
from momdiary.agents.dispatcher import AgentRunResult
from momdiary.agents.session_store import ChatTurn
from momdiary.agents.tools.descriptions import TOOL_DESCRIPTIONS
from momdiary.agents.tools.registry import (
    READ_TOOL_REGISTRY,
    TOOL_REGISTRY,
    invoke_tool,
)
from momdiary.observability.logging import get_logger
from momdiary.services.time_service import get_default_timezone

logger = get_logger(__name__)


def _build_tool_wrappers(
    session: AsyncSession, captured: list[AgentRunResult]
) -> list[Any]:
    """Build per-request tool callables that bind `session` and capture results."""

    wrappers: list[Any] = []

    for tool_name, tool_fn in TOOL_REGISTRY.items():
        original_sig = inspect.signature(tool_fn)
        # Strip the `session` positional from the public signature so MAF
        # generates a JSON schema with only the model-facing parameters.
        public_params = [
            p
            for p in original_sig.parameters.values()
            if p.name != "session"
            and p.kind
            in (
                inspect.Parameter.KEYWORD_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            )
        ]
        public_sig = original_sig.replace(parameters=public_params)
        public_anns = {
            k: v for k, v in tool_fn.__annotations__.items() if k != "session"
        }

        def _make(
            name: str, fn: Any, sig: inspect.Signature, anns: dict[str, Any]
        ) -> Any:
            async def wrapper(**kwargs: Any) -> str:
                result = await fn(session, **kwargs)
                captured.append(result)
                return result.agent_message or "ok"

            wrapper.__name__ = name
            wrapper.__qualname__ = name
            wrapper.__doc__ = TOOL_DESCRIPTIONS.get(
                name, fn.__doc__ or f"MomDiary tool: {name}"
            )
            wrapper.__signature__ = sig  # type: ignore[attr-defined]
            wrapper.__annotations__ = anns
            return wrapper

        wrappers.append(_make(tool_name, tool_fn, public_sig, public_anns))

    # Read-only tools: execute, serialize the result back to the model as
    # JSON text, and do NOT append to `captured` (so they never become the
    # final response envelope; the model uses their data to answer or to
    # choose a follow-up write/delete tool).
    for read_name, read_fn in READ_TOOL_REGISTRY.items():
        read_sig = inspect.signature(read_fn)
        read_public_params = [
            p
            for p in read_sig.parameters.values()
            if p.name != "session"
            and p.kind
            in (
                inspect.Parameter.KEYWORD_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            )
        ]
        read_public_sig = read_sig.replace(parameters=read_public_params)
        read_public_anns = {
            k: v for k, v in read_fn.__annotations__.items() if k != "session"
        }

        def _make_read(
            name: str, fn: Any, sig: inspect.Signature, anns: dict[str, Any]
        ) -> Any:
            async def wrapper(**kwargs: Any) -> str:
                try:
                    data = await fn(session, **kwargs)
                except ValueError as exc:
                    return json.dumps({"error": "validation_error", "message": str(exc)})
                except Exception as exc:  # noqa: BLE001 - surface to model, never crash
                    logger.exception("read_tool.failed", tool=name)
                    return json.dumps({"error": "internal_error", "message": str(exc)})
                return json.dumps(data, default=str)

            wrapper.__name__ = name
            wrapper.__qualname__ = name
            wrapper.__doc__ = TOOL_DESCRIPTIONS.get(
                name, fn.__doc__ or f"MomDiary read tool: {name}"
            )
            wrapper.__signature__ = sig  # type: ignore[attr-defined]
            wrapper.__annotations__ = anns
            return wrapper

        wrappers.append(_make_read(read_name, read_fn, read_public_sig, read_public_anns))

    # Pseudo-tool: the model can call this to request more info.
    async def ask_for_clarification(
        question: str, suggested_candidates: list[dict[str, Any]] | None = None
    ) -> str:
        """Ask the caregiver to clarify ambiguous input. Does not persist anything."""
        captured.append(
            AgentRunResult(
                selected_tool="ask_for_clarification",
                outcome="clarification_requested",
                agent_message=question,
                suggested_candidates=suggested_candidates,
            )
        )
        return question

    wrappers.append(ask_for_clarification)
    return wrappers


async def _format_context(
    session: AsyncSession, entry_id: int | None, entry_type: str | None
) -> str:
    tz = await get_default_timezone(session)
    now_local = datetime.now(tz)
    lines = [
        f"Current local time: {now_local.isoformat(timespec='seconds')} ({tz.key}).",
        "When the caregiver omits a date, assume today in this timezone.",
    ]
    if entry_id is not None and entry_type is not None:
        lines.append(
            f"Authoritative target for this turn: entry_id={entry_id}, "
            f"entry_type={entry_type}. Use the matching update_* or delete_* tool."
        )
    return "\n".join(lines)


def _render_history(history: list[ChatTurn]) -> str:
    """Render prior turns as plain-text role-prefixed lines (FR-004).

    Format mirrors the canonical sequence in `plan.md#agent-invocation-flow`.
    Empty history -> empty string (caller elides the "Conversation so far:" block).
    Assistant turns whose outcome was a write (created/updated/deleted) get a
    trailing `(<outcome> <entry_type>#<entry_id>)` parenthetical so the model
    can resolve references like "the feed I just logged" without re-reading
    the database.
    """
    if not history:
        return ""
    lines: list[str] = []
    for turn in history:
        prefix = "Caregiver" if turn.role == "caregiver" else "Assistant"
        line = f"{prefix}: {turn.text}"
        if (
            turn.role == "assistant"
            and turn.outcome in {"created", "updated", "deleted"}
            and turn.entry_type is not None
            and turn.entry_id is not None
        ):
            line += f" ({turn.outcome} {turn.entry_type}#{turn.entry_id})"
        lines.append(line)
    return "\n".join(lines)


class MAFAgentRunner:
    """Runs the real Microsoft Agent Framework agent end-to-end."""

    async def run(
        self,
        message: str,
        *,
        session: AsyncSession,
        correlation_id: str,
        entry_id: int | None = None,
        entry_type: str | None = None,
        history: list[ChatTurn] | None = None,
    ) -> AgentRunResult:
        assert history is not None, (
            "MAFAgentRunner.run: `history` is required (pass [] for fresh sessions). "
            "FR-004 enforces that the dispatcher always supplies the recent_view."
        )
        captured: list[AgentRunResult] = []
        tools = _build_tool_wrappers(session, captured)
        bundle = build_agent(tools=tools)
        logger.info(
            "maf.agent.built",
            correlation_id=correlation_id,
            tool_count=len(tools),
            hinted_entry_id=entry_id,
            hinted_entry_type=entry_type,
            history_turns=len(history),
        )

        context = await _format_context(session, entry_id, entry_type)
        history_block = _render_history(history)
        if history_block:
            full_message = (
                f"{context}\n\n"
                f"Conversation so far:\n{history_block}\n\n"
                f"Caregiver said: {message}"
            )
        else:
            full_message = f"{context}\n\nCaregiver said: {message}"

        logger.debug(
            "maf.model.invoking",
            correlation_id=correlation_id,
            message_len=len(full_message),
        )
        try:
            response = await bundle.agent.run(full_message)
        except Exception:
            logger.exception("maf.model.failed", correlation_id=correlation_id)
            raise
        logger.info(
            "maf.model.completed",
            correlation_id=correlation_id,
            captured_tools=[c.selected_tool for c in captured],
        )

        if captured:
            # If the model chose multiple tools we honour the last one;
            # the dispatcher's audit row captures the final outcome.
            return captured[-1]

        # Model produced text but called no tool — surface as clarification.
        text = (
            getattr(response, "text", None)
            or str(response)
            or "Could you provide more details?"
        )
        logger.info(
            "maf.no_tool_called",
            correlation_id=correlation_id,
            text_len=len(text),
        )
        return AgentRunResult(
            selected_tool=None,
            outcome="clarification_requested",
            agent_message=text,
        )


# Convenience helper for endpoint-bypass paths (T068 deterministic update/delete).
async def invoke_named_tool(
    session: AsyncSession, name: str, **kwargs: Any
) -> AgentRunResult:
    return await invoke_tool(name, session, **kwargs)
