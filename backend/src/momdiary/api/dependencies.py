"""HTTP endpoint dependencies + agent factory wiring.

Tests override `get_agent_runner` via `app.dependency_overrides` to inject
the deterministic scripted agent (Principle II).
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from momdiary.agents.dispatcher import AgentDispatcher, AgentRunner
from momdiary.agents.session_store import InMemorySessionStore, SessionStore
from momdiary.config import get_settings
from momdiary.db.engine import get_session

_session_store: InMemorySessionStore | None = None


def get_session_store() -> SessionStore:
    """Return the process-lifetime in-memory session store (feature 003)."""
    global _session_store
    if _session_store is None:
        settings = get_settings()
        _session_store = InMemorySessionStore(
            ttl_seconds=settings.momdiary_session_ttl_seconds,
            max_turns=settings.momdiary_session_max_turns,
            max_sessions=settings.momdiary_session_max_sessions,
            message_max_bytes=settings.momdiary_session_message_max_bytes,
        )
    return _session_store


def reset_session_store_for_tests() -> None:
    """Drop the singleton so the next call rebuilds it (test-only)."""
    global _session_store
    _session_store = None


async def get_agent_runner() -> AgentRunner:  # pragma: no cover - replaced in tests
    """Build the real MAF-backed agent runner.

    Imported lazily so test environments need not install MAF.
    """
    from momdiary.agents.maf_runner import MAFAgentRunner

    return MAFAgentRunner()


def get_chatentry_chat_client():  # pragma: no cover - replaced in tests
    """Construct the production direct-LLM chat client (feature 005).

    Tests override this dependency with a deterministic
    ``FakeChatClient`` via ``app.dependency_overrides`` (Principle II).
    """
    from momdiary.services.chatentry_dispatcher import (
        _build_chatentry_chat_client,
    )

    return _build_chatentry_chat_client()


async def get_dispatcher(
    agent: AgentRunner = Depends(get_agent_runner),
    session: AsyncSession = Depends(get_session),
) -> AgentDispatcher:
    return AgentDispatcher(agent=agent, session=session)


def build_response_envelope(
    dispatch_result: Any,
    *,
    session_id: str,
) -> tuple[int, dict[str, Any]]:
    """Translate an `AgentDispatcher.dispatch()` result into (status, body)."""
    res = dispatch_result.result
    cid = dispatch_result.correlation_id

    if res.outcome == "clarification_requested":
        body = {
            "outcome": "clarification_requested",
            "agent_message": res.agent_message or "Could you clarify?",
            "correlation_id": cid,
            "session_id": session_id,
        }
        if res.suggested_candidates:
            body["suggested_candidates"] = res.suggested_candidates
        return 200, body

    if res.outcome == "rejected":
        body = {
            "error": "not_found" if res.entry_id else "validation_error",
            "message": res.agent_message or "Request rejected.",
            "correlation_id": cid,
            "session_id": session_id,
        }
        return 404 if res.entry_id else 400, body

    status_map = {"created": 201, "updated": 200, "deleted": 200}
    status = status_map.get(res.outcome, 200)
    body = {
        "outcome": res.outcome,
        "entry_type": res.entry_type,
        "entry": res.payload,
        "agent_message": res.agent_message,
        "correlation_id": cid,
        "session_id": session_id,
    }
    return status, body
