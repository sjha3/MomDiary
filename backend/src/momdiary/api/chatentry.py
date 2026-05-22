"""POST `/v1/chatentry/` — direct-LLM dispatch endpoint (feature 005).

Independent path from `/v1/entries`. Reuses the same tool registry and
session store but never instantiates an Agent / ChatAgent (FR-003).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from momdiary.agents.session_store import (
    ChatTurn,
    SessionMessageTooLargeError,
    SessionStore,
)
from momdiary.api.dependencies import (
    get_chatentry_chat_client,
    get_session_store,
)
from momdiary.config import Settings, get_settings
from momdiary.db.engine import get_session
from momdiary.models.schemas import ChatEntryRequest, ChatEntryResponse
from momdiary.observability.logging import get_logger
from momdiary.observability.middleware import current_correlation_id
from momdiary.services.chatentry_dispatcher import (
    ChatClientProtocol,
    run_chatentry,
)

logger = get_logger(__name__)

router = APIRouter(tags=["chatentry"])


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _correlation_id(req: ChatEntryRequest) -> str:
    return req.correlation_id or current_correlation_id() or "unknown"


@router.post(
    "/chatentry/",
    response_model=ChatEntryResponse,
    summary="One-shot LLM dispatch that creates / updates / deletes a single entry.",
)
async def chatentry_dispatch(
    payload: ChatEntryRequest,
    response: Response,
    db_session: Annotated[AsyncSession, Depends(get_session)],
    store: Annotated[SessionStore, Depends(get_session_store)],
    chat_client: Annotated[
        ChatClientProtocol, Depends(get_chatentry_chat_client)
    ],
    settings: Annotated[Settings, Depends(get_settings)],
    x_session_id: Annotated[str | None, Header(alias="X-Session-ID")] = None,
) -> ChatEntryResponse:
    cid = _correlation_id(payload)

    # FR-014: per-message byte cap. Reject before the LLM call.
    encoded_len = len(payload.message.encode("utf-8"))
    if encoded_len > settings.momdiary_session_message_max_bytes:
        logger.warning(
            "chatentry.message_too_large",
            correlation_id=cid,
            message_bytes=encoded_len,
            max_bytes=settings.momdiary_session_message_max_bytes,
        )
        raise HTTPException(
            status_code=400,
            detail={
                "error": "validation_error",
                "message": (
                    f"Caregiver message exceeds the configured size cap "
                    f"({encoded_len} > "
                    f"{settings.momdiary_session_message_max_bytes} bytes)."
                ),
                "correlation_id": cid,
            },
        )

    chat_session = await store.get_or_create(x_session_id, correlation_id=cid)
    logger.info(
        "chatentry.received",
        correlation_id=cid,
        session_id=chat_session.id,
        message_len=len(payload.message),
        history_turns=len(payload.history),
        session_id_present=x_session_id is not None,
    )

    async with chat_session.lock:
        # Append the caregiver's turn first so resolve_history (called by
        # run_chatentry) sees it on subsequent requests of this session.
        # The current request resolves history BEFORE this turn lands so
        # the LLM still sees only prior turns plus the current message.
        caregiver_turn = ChatTurn(
            role="caregiver",
            text=payload.message,
            correlation_id=cid,
            created_at=_utc_now(),
        )
        result = await run_chatentry(
            payload,
            db_session=db_session,
            chat_client=chat_client,
            chat_session=chat_session,
            store=store,
            settings=settings,
            correlation_id=cid,
        )

        # Persist the caregiver + assistant turns to the session store so
        # follow-up requests (US2 / US3) can resolve "it" / "that" without
        # re-sending history. Failures must not break the HTTP response
        # (mirrors the convention from feature 003).
        try:
            await store.append(chat_session, caregiver_turn)
        except SessionMessageTooLargeError:
            logger.warning(
                "chatentry.session.message_too_large",
                correlation_id=cid,
                session_id=chat_session.id,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "chatentry.session.append_failed",
                correlation_id=cid,
                session_id=chat_session.id,
                exc_info=True,
            )

        if result.outcome != "error":
            assistant_outcome: str | None = result.outcome
            if assistant_outcome == "clarification_requested":
                pass  # keep as-is
            assistant_turn = ChatTurn(
                role="assistant",
                text=result.agent_message,
                correlation_id=cid,
                created_at=_utc_now(),
                outcome=assistant_outcome,  # type: ignore[arg-type]
                entry_type=result.entry_type,
                entry_id=result.entry_id,
            )
            try:
                await store.append(chat_session, assistant_turn)
            except SessionMessageTooLargeError:
                logger.warning(
                    "chatentry.session.assistant_turn_dropped",
                    correlation_id=cid,
                    session_id=chat_session.id,
                )
            except Exception:  # noqa: BLE001
                logger.warning(
                    "chatentry.session.append_failed",
                    correlation_id=cid,
                    session_id=chat_session.id,
                    exc_info=True,
                )
        # else: do NOT append a phantom assistant turn for error outcomes
        # (per FR-013 edge case: "no phantom assistant turn").

    # Status mapping: contract says HTTP 200 for all five outcomes.
    response.status_code = 200
    response.headers["X-Session-ID"] = chat_session.id
    return result
