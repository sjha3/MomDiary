"""Integration tests for `POST /v1/chatentry/` (feature 005)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from httpx import AsyncClient


pytestmark = pytest.mark.asyncio


def _past(minutes: int = 10) -> str:
    """Return an ISO-8601 timestamp `minutes` ago in UTC."""
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _future(days: int = 5) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


# ---------------------------------------------------------------------------
# US1 — one-shot create per domain.
# ---------------------------------------------------------------------------


async def _post(client: AsyncClient, message: str, **kwargs: Any) -> Any:
    return await client.post(
        "/v1/chatentry/", json={"message": message, **kwargs}
    )


async def test_us1_create_feed_one_shot(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    occurred = _past(5)
    fake_chat_client.script_tool_call(
        "log_feed",
        feed_type="breast_milk",
        quantity=120,
        unit="ml",
        occurred_at=occurred,
    )
    resp = await _post(chatentry_client, "120 ml breast milk just now")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["outcome"] == "created"
    assert body["entry_type"] == "feed"
    assert isinstance(body["entry_id"], int)
    assert body["selected_tool"] == "log_feed"
    assert body["correlation_id"]
    assert body["session_id"]
    assert resp.headers["x-session-id"] == body["session_id"]
    feeds = await chatentry_client.get(f"/v1/feeds?date={_today()}")
    items = feeds.json()["items"]
    assert any(i["id"] == body["entry_id"] for i in items)


async def test_us1_create_sleep_one_shot(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_tool_call(
        "log_sleep",
        start_at=_past(120),
        end_at=_past(60),
    )
    resp = await _post(chatentry_client, "Liam slept from 1pm to 3pm")
    body = resp.json()
    assert resp.status_code == 200
    assert body["outcome"] == "created"
    assert body["entry_type"] == "sleep"
    assert body["entry_id"]


async def test_us1_create_poop_one_shot(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_tool_call(
        "log_poop",
        occurred_at=_past(10),
        consistency="soft",
    )
    resp = await _post(chatentry_client, "Yellow seedy poop 10 minutes ago")
    body = resp.json()
    assert resp.status_code == 200
    assert body["outcome"] == "created"
    assert body["entry_type"] == "poop"


async def test_us1_create_appointment_one_shot(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_tool_call(
        "log_appointment",
        scheduled_at=_future(7),
    )
    resp = await _post(chatentry_client, "Pediatrician next Tuesday at 10am")
    body = resp.json()
    assert resp.status_code == 200
    assert body["outcome"] == "created"
    assert body["entry_type"] == "appointment"


# ---------------------------------------------------------------------------
# US2 — two-turn correction / delete with session id threaded.
# ---------------------------------------------------------------------------


async def test_us2_two_turn_feed_correction(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_tool_call(
        "log_feed",
        feed_type="breast_milk",
        quantity=120,
        unit="ml",
        occurred_at=_past(5),
    )
    r1 = await _post(chatentry_client, "120 ml breast milk")
    body1 = r1.json()
    sid = body1["session_id"]
    feed_id = body1["entry_id"]

    fake_chat_client.script_tool_call("update_feed", entry_id=feed_id, quantity=90)
    r2 = await chatentry_client.post(
        "/v1/chatentry/",
        json={"message": "actually make it 90"},
        headers={"X-Session-ID": sid},
    )
    body2 = r2.json()
    assert r2.status_code == 200
    assert body2["session_id"] == sid
    assert body2["outcome"] == "updated"
    assert body2["entry_id"] == feed_id

    # The second LLM call should have seen turn 1 in `messages`.
    second_call_messages = fake_chat_client.calls[1]["messages"]
    user_or_assistant = [m for m in second_call_messages if m["role"] != "system"]
    assert any("120 ml breast milk" in m["content"] for m in user_or_assistant)
    assert any(
        f"feed#{feed_id}" in m["content"]
        for m in user_or_assistant
        if m["role"] == "assistant"
    )


async def test_us2_two_turn_poop_delete(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_tool_call(
        "log_poop",
        occurred_at=_past(10),
        consistency="soft",
    )
    r1 = await _post(chatentry_client, "soft poop 10 min ago")
    sid = r1.json()["session_id"]
    poop_id = r1.json()["entry_id"]

    fake_chat_client.script_tool_call("delete_poop", entry_id=poop_id)
    r2 = await chatentry_client.post(
        "/v1/chatentry/",
        json={"message": "delete that"},
        headers={"X-Session-ID": sid},
    )
    body2 = r2.json()
    assert body2["outcome"] == "deleted"
    assert body2["entry_id"] == poop_id


# ---------------------------------------------------------------------------
# US3 — clarification, no DB writes.
# ---------------------------------------------------------------------------


async def test_us3_no_history_delete_that_returns_clarification(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_clarification("Which entry should I delete?")
    today = _today()
    feeds_before = (await chatentry_client.get(f"/v1/feeds?date={today}")).json()
    poops_before = (await chatentry_client.get(f"/v1/poops?date={today}")).json()
    sleeps_before = (await chatentry_client.get(f"/v1/sleeps?date={today}")).json()
    appts_before = (
        await chatentry_client.get(f"/v1/appointments?date={today}")
    ).json()

    resp = await _post(chatentry_client, "delete that")
    body = resp.json()
    assert resp.status_code == 200
    assert body["outcome"] == "clarification_requested"
    assert body["agent_message"]
    assert body["entry_id"] is None
    assert body["entry_type"] is None

    feeds_after = (await chatentry_client.get(f"/v1/feeds?date={today}")).json()
    poops_after = (await chatentry_client.get(f"/v1/poops?date={today}")).json()
    sleeps_after = (await chatentry_client.get(f"/v1/sleeps?date={today}")).json()
    appts_after = (
        await chatentry_client.get(f"/v1/appointments?date={today}")
    ).json()
    assert feeds_after == feeds_before
    assert poops_after == poops_before
    assert sleeps_after == sleeps_before
    assert appts_after == appts_before


async def test_us3_missing_quantity_returns_clarification(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_clarification(
        "How much milk did Liam have?"
    )
    resp = await _post(chatentry_client, "logged some milk")
    body = resp.json()
    assert body["outcome"] == "clarification_requested"
    assert "milk" in body["agent_message"].lower()


# ---------------------------------------------------------------------------
# Failure modes (Phase 6) — malformed output, unknown tool, invalid args, llm fail.
# ---------------------------------------------------------------------------


async def test_malformed_json_returns_error_no_write(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_raw({"kind": "garbled"})
    resp = await _post(chatentry_client, "120 ml breast milk")
    body = resp.json()
    assert resp.status_code == 200
    assert body["outcome"] == "error"
    assert body["error_reason"] == "malformed_llm_output"
    feeds = (await chatentry_client.get(f"/v1/feeds?date={_today()}")).json()
    assert feeds["items"] == []


async def test_unknown_tool_returns_error(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_tool_call("log_unicorn", color="rainbow")
    resp = await _post(chatentry_client, "ride a unicorn")
    body = resp.json()
    assert body["outcome"] == "error"
    assert body["error_reason"] == "unknown_tool"


async def test_invalid_arguments_returns_error(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.script_tool_call(
        "log_feed",
        feed_type="breast_milk",
        quantity=-1,
        unit="ml",
        occurred_at=_past(5),
    )
    resp = await _post(chatentry_client, "minus one ml of milk")
    body = resp.json()
    assert body["outcome"] == "error"
    assert body["error_reason"] == "invalid_tool_arguments"
    feeds = (await chatentry_client.get(f"/v1/feeds?date={_today()}")).json()
    assert feeds["items"] == []


async def test_llm_timeout_returns_error(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    fake_chat_client.raise_on_next(TimeoutError("model timed out"))
    resp = await _post(chatentry_client, "something")
    body = resp.json()
    assert body["outcome"] == "error"
    assert body["error_reason"] == "llm_unavailable"


async def test_message_size_cap_rejected_400(
    chatentry_client: AsyncClient, fake_chat_client: Any
) -> None:
    huge = "x" * 9000  # > 8192 schema cap, also > byte cap
    resp = await chatentry_client.post(
        "/v1/chatentry/", json={"message": huge}
    )
    # Pydantic validation kicks in before the byte-cap branch (max_length
    # on the model). Either way the request is rejected without writes.
    assert resp.status_code in (400, 422)
    feeds = (await chatentry_client.get(f"/v1/feeds?date={_today()}")).json()
    assert feeds["items"] == []
