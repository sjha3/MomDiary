# MomDiary Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-05-20

## Active Technologies
- Python 3.12 + FastAPI, Microsoft Agent Framework (`agent-framework`, `agent-framework-azure-ai`, prerelease per constitution), `azure-identity`, SQLAlchemy 2.x (async) + `aiosqlite`, Alembic, Pydantic v2, `structlog` (or `python-json-logger`) (001-setup-environment)
- SQLite (local file via `sqlite+aiosqlite`), Alembic-managed schema (001-setup-environment)
- TypeScript 5.4 (frontend), Python 3.12 (existing backend, unchanged here) + React 18, Vite 5, TanStack Query v5, Tailwind CSS 3, `zod` (response validation), `date-fns` + `date-fns-tz` (local-time rendering) (002-tracker-ux-chat)
- None on the client (chat history is React state for the session; selected date is React state, not persisted) (002-tracker-ux-chat)
- Python 3.12 (backend, unchanged) + FastAPI, `agent-framework==1.0.0rc6`, `agent-framework-azure-ai==1.0.0rc6`, `azure-identity`, SQLAlchemy 2.x async, `pydantic` v2, `structlog` (003-chat-session-store)
- In-memory (Python dict in the FastAPI process). No SQLite/Alembic changes. The existing `momdiary.db` file is untouched. (003-chat-session-store)
- Python 3.12 (backend, unchanged from prior features) (004-chat-entries-api)
- Existing SQLite file (`momdiary.db`) via existing repositories. (004-chat-entries-api)
- Python 3.12 (backend, unchanged from prior features). (005-direct-llm-chatentry)
- Existing SQLite file (`momdiary.db`) via the existing (005-direct-llm-chatentry)

- [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION] + [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION] (001-setup-environment)

## Project Structure

```text
backend/
frontend/
tests/
```

## Commands

cd src; pytest; ruff check .

## Code Style

[e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]: Follow standard conventions

## Recent Changes
- 005-direct-llm-chatentry: Added Python 3.12 (backend, unchanged from prior features).
- 004-chat-entries-api: Added Python 3.12 (backend, unchanged from prior features)
- 003-chat-session-store: Added in-memory `SessionStore` (process-singleton, bounded by TTL / max_turns / max_sessions / message_max_bytes / prompt_token_budget). History threaded through `MAFAgentRunner.run(..., history=...)`. `X-Session-ID` request/response header on `/v1/entries` (POST + PUT). Required `session_id` on `AgentWriteResponse` / `AgentClarificationResponse` / `ErrorResponse`.


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
