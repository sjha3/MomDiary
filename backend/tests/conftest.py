"""Shared pytest fixtures: ephemeral SQLite + MAF stub agent."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from momdiary.agents.dispatcher import AgentRunResult
from momdiary.agents.tools.registry import invoke_tool
from momdiary.api.dependencies import get_agent_runner
from momdiary.db.engine import (
    dispose_engine,
    get_session_factory,
    reset_engine_for_tests,
)
from momdiary.services.time_service import reset_timezone_cache


# ---------------------------------------------------------------------------
# Ephemeral SQLite + migrations
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_path(tmp_path: Path) -> AsyncIterator[Path]:
    p = tmp_path / "momdiary-test.db"
    yield p
    if p.exists():
        p.unlink(missing_ok=True)


@pytest_asyncio.fixture
async def configured_app(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[Any]:
    """Configure env, run migrations on an ephemeral DB, yield FastAPI app."""
    monkeypatch.setenv("MOMDIARY_DB_URL", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setenv("MOMDIARY_DEFAULT_TIMEZONE", "America/Los_Angeles")
    monkeypatch.setenv("MOMDIARY_APP_ENV", "test")

    from momdiary.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    reset_engine_for_tests()
    reset_timezone_cache()

    from momdiary.api.dependencies import reset_session_store_for_tests

    reset_session_store_for_tests()

    from alembic import command
    from alembic.config import Config

    cfg_path = Path(__file__).resolve().parents[1] / "alembic.ini"
    alembic_cfg = Config(str(cfg_path))
    alembic_cfg.set_main_option(
        "sqlalchemy.url", f"sqlite+aiosqlite:///{db_path}"
    )
    await asyncio.to_thread(command.upgrade, alembic_cfg, "head")

    from momdiary.main import create_app

    app = create_app()
    try:
        yield app
    finally:
        await dispose_engine()
        reset_engine_for_tests()
        get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest_asyncio.fixture
async def session(configured_app: Any) -> AsyncIterator[AsyncSession]:
    factory = get_session_factory()
    async with factory() as s:
        yield s


# ---------------------------------------------------------------------------
# Scripted agent — deterministic, no live model (Principle II)
# ---------------------------------------------------------------------------


@dataclass
class _ScriptItem:
    tool_name: str
    kwargs: dict[str, Any]


@dataclass
class ScriptedAgent:
    """Plays a pre-scripted sequence of tool invocations.

    Each `run()` call pops one `(tool_name, kwargs)` pair from the queue,
    executes it against the live session via the shared tool registry,
    and returns the resulting `AgentRunResult`. This means tests exercise
    the real repositories and produce real side effects — only the model
    is stubbed out.
    """

    _queue: list[_ScriptItem] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)

    def script(self, tool_name: str, **kwargs: Any) -> "ScriptedAgent":
        self._queue.append(_ScriptItem(tool_name=tool_name, kwargs=kwargs))
        return self

    async def run(
        self,
        message: str,
        *,
        session: AsyncSession,
        correlation_id: str,
        entry_id: int | None = None,
        entry_type: str | None = None,
        history: list[Any] | None = None,
    ) -> AgentRunResult:
        self.calls.append(
            {
                "message": message,
                "correlation_id": correlation_id,
                "entry_id": entry_id,
                "entry_type": entry_type,
                "history": list(history) if history is not None else [],
            }
        )
        if not self._queue:
            raise AssertionError(
                "ScriptedAgent.run() called with no scripted tool calls remaining"
            )
        item = self._queue.pop(0)
        return await invoke_tool(item.tool_name, session, **item.kwargs)


@pytest.fixture
def scripted_agent() -> ScriptedAgent:
    return ScriptedAgent()


@pytest_asyncio.fixture
async def client(
    configured_app: Any, scripted_agent: ScriptedAgent
) -> AsyncIterator[AsyncClient]:
    configured_app.dependency_overrides[get_agent_runner] = lambda: scripted_agent
    async with AsyncClient(
        transport=ASGITransport(app=configured_app), base_url="http://test"
    ) as c:
        yield c
    configured_app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Direct-LLM chat-entry fake client (feature 005)
# ---------------------------------------------------------------------------


@dataclass
class FakeChatClient:
    """Deterministic ChatClientProtocol for /v1/chatentry/ tests.

    Each ``get_response()`` call pops one scripted decision dict from
    ``_queue`` and returns it as the parsed LLM JSON. Use ``script(...)``
    to enqueue ``tool_call`` or ``clarification`` decisions; use
    ``script_raw(...)`` to enqueue malformed payloads; use
    ``raise_on_next(exc)`` to simulate an LLM transport failure.
    """

    _queue: list[Any] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)

    def script_tool_call(
        self, tool_name: str, **arguments: Any
    ) -> "FakeChatClient":
        self._queue.append(
            {"kind": "tool_call", "tool_name": tool_name, "arguments": arguments}
        )
        return self

    def script_clarification(
        self,
        question: str,
        suggested_candidates: list[dict[str, Any]] | None = None,
    ) -> "FakeChatClient":
        payload: dict[str, Any] = {"kind": "clarification", "question": question}
        if suggested_candidates is not None:
            payload["suggested_candidates"] = suggested_candidates
        self._queue.append(payload)
        return self

    def script_raw(self, payload: Any) -> "FakeChatClient":
        self._queue.append(payload)
        return self

    def raise_on_next(self, exc: BaseException) -> "FakeChatClient":
        self._queue.append(exc)
        return self

    async def get_response(
        self,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any],
    ) -> dict[str, Any]:
        self.calls.append({"messages": list(messages), "response_format": response_format})
        if not self._queue:
            raise AssertionError(
                "FakeChatClient.get_response() called with no scripted decisions remaining"
            )
        item = self._queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


@pytest.fixture
def fake_chat_client() -> FakeChatClient:
    return FakeChatClient()


@pytest_asyncio.fixture
async def chatentry_client(
    configured_app: Any,
    scripted_agent: ScriptedAgent,
    fake_chat_client: FakeChatClient,
) -> AsyncIterator[AsyncClient]:
    """HTTP client wired with both the scripted agent (feature 001) and the
    fake chat client (feature 005) so tests can exercise both endpoints.
    """
    from momdiary.api.dependencies import get_chatentry_chat_client

    configured_app.dependency_overrides[get_agent_runner] = lambda: scripted_agent
    configured_app.dependency_overrides[get_chatentry_chat_client] = (
        lambda: fake_chat_client
    )
    async with AsyncClient(
        transport=ASGITransport(app=configured_app), base_url="http://test"
    ) as c:
        yield c
    configured_app.dependency_overrides.clear()
