# Implementation Plan: Direct-LLM Chat Entry Endpoint

**Branch**: `005-direct-llm-chatentry` | **Date**: 2026-05-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-direct-llm-chatentry/spec.md`

## Summary

Add a brand-new HTTP endpoint `POST /v1/chatentry/` that turns a single
caregiver message (plus optional chat history and an optional session id)
into exactly one create / update / delete on the existing entry tables
(feed, sleep, poop, appointment) — without using the Microsoft Agent
Framework `Agent` / `ChatAgent` runtime (FR-003).

Architecture is a single-shot dispatcher:

1. The HTTP handler assembles a prompt = `(SYSTEM_PROMPT || tool catalog ||
   trimmed history || caregiver message)` from inputs.
2. The dispatcher calls `agent_framework.azure.AzureOpenAIChatClient`
   directly (the same MAF chat-client primitive already used by
   `diary_agent.py`) with a forced JSON response schema describing one of
   two LLM-decision shapes: `tool_call` or `clarification`.
3. The structured response is parsed into a `LLMDecision` Pydantic model.
   Unknown tool names, missing required parameters, or malformed shapes
   are rejected before any DB write (FR-005, edge case "malformed output").
4. On a valid `tool_call`, the dispatcher calls
   `momdiary.agents.tools.registry.invoke_tool(name, session, **params)` —
   the exact same callable used by the existing diary agent — so
   semantics (soft-delete, idempotency, validation, time-zone handling)
   are byte-identical to feature 001.
5. The result is normalized into a `ChatEntryResponse` envelope and the
   session store (when a session id is supplied) is updated with the
   caregiver + assistant turns, exactly as `/v1/entries` does today.

Constitution Principle V is preserved by keeping the call on a Microsoft
Agent Framework primitive (`AzureOpenAIChatClient`) — the same client the
diary agent already uses — while NOT instantiating the higher-level
`Agent` / `ChatAgent` abstraction. This is the architectural seam the
feature spec explicitly requested in FR-003. The justification is recorded
under Complexity Tracking.

## Technical Context

**Language/Version**: Python 3.12 (backend, unchanged from prior features).
**Primary Dependencies**:

- FastAPI (existing) — new router under `backend/src/momdiary/api/`.
- `agent-framework-core==1.0.0b251211` and
  `agent-framework-azure-ai==1.0.0b251211` (existing prerelease per
  Principle V) — used at the **ChatClient** level only
  (`AzureOpenAIChatClient.get_response(messages=..., response_format=...)`);
  the `ChatAgent` / `Agent` classes are NOT used by this endpoint.
- `azure-identity` (existing) — `DefaultAzureCredential` for the chat
  client.
- `pydantic` v2 — request, response, tool-catalog, and `LLMDecision`
  validation models.
- SQLAlchemy 2.x async + `aiosqlite` (existing) — reuse of existing
  repositories and the `AsyncSession` dependency.
- `structlog` (existing) — structured logging per Principle V.

**Storage**: Existing SQLite file (`momdiary.db`) via the existing
repositories (`FeedsRepository`, `SleepsRepository`, `PoopsRepository`,
`AppointmentsRepository`). No new tables, no Alembic migration. The
in-memory `SessionStore` from feature 003 is reused as-is when a session id
is supplied.

**Testing**: `pytest` + `pytest-asyncio` + `httpx.AsyncClient` (existing
test stack). The chat client is injected behind a small
`ChatClientProtocol` so contract / integration tests substitute a
deterministic fake — no live model calls in CI (Principle II).

**Target Platform**: Linux/Windows ASGI host (existing uvicorn deployment).

**Project Type**: Web application — backend-only delivery for this
feature. Frontend wiring is explicitly out of scope per the spec.

**Performance Goals**:

- p50 end-to-end latency ≤ 3 s, p95 ≤ 6 s on the development LLM
  deployment (SC-005).
- Internal (non-LLM) handler work ≤ 100 ms p95: prompt assembly + LLM
  decision parsing + tool dispatch + response serialization.
- LLM call latency MUST be logged separately from total handler latency
  (Principle III + FR-010).

**Constraints**:

- Constitution Principle V: stay on Microsoft Agent Framework primitives;
  `AzureOpenAIChatClient` qualifies. The decision to skip
  `Agent` / `ChatAgent` is captured in Complexity Tracking below.
- Idempotency on retried writes is inherited from the existing tool
  layer; this feature adds no new dedup cache.
- Per-message size cap and total prompt-token budget MUST be configurable
  via existing settings (`momdiary_session_message_max_bytes`,
  `momdiary_session_prompt_token_budget`) — see FR-014.
- Coverage: ≥ 80 % line on changed packages (Principle II).
- Out of scope: edits to `/v1/entries` (feature 001), edits to feature
  004's `/chatentries` if present, frontend wiring, persistent session
  storage.

**Scale/Scope**: Single caregiver per backend instance (matches existing
diary scope); ~50–200 requests/day expected.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1
design.*

| Principle                                            | Status                                                | Notes                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| I. Code Quality & Maintainability                    | PASS                                                  | New code lives in three small modules: `api/chatentry.py` (HTTP), `services/chatentry_dispatcher.py` (LLM call + decision parsing + tool routing), `services/chatentry_catalog.py` (tool-catalog projection from the existing registry). All public symbols carry docstrings. Projected cyclomatic complexity per function ≤ 10.                       |
| II. Testing Standards (NON-NEGOTIABLE)               | PASS                                                  | Test plan (Phase 1 → tasks): contract tests for the OpenAPI envelope, unit tests for the dispatcher (one per tool family + clarification + malformed branches), integration tests covering the three user stories with a deterministic fake `ChatClientProtocol`, an LLM-failure / timeout test, a tool-catalog-drift test. No live-model calls in CI. |
| III. Performance Requirements                        | PASS                                                  | LLM latency logged separately. Handler-side budget ≤ 100 ms p95 enforced by a `pytest-benchmark` micro-benchmark (parked behind the existing opt-in marker). End-to-end SLOs (SC-005) tracked at runtime via the existing `structlog` pipeline.                                                                                                        |
| IV. Modular Architecture                             | PASS                                                  | Endpoint has one responsibility (HTTP plumbing). LLM call sits behind a `ChatClientProtocol` — swappable per Principle IV. Tool catalog is *projected* from the existing `TOOL_REGISTRY`; tools themselves are reused without modification. Cross-module access is through public interfaces; no cyclic dependencies introduced.                       |
| V. Microsoft Agent Framework First (NON-NEGOTIABLE)  | PASS (with documented scope-narrowing)                | Implementation stays on `AzureOpenAIChatClient` (an MAF primitive). The deliberate non-use of `Agent` / `ChatAgent` is justified in Complexity Tracking below: the spec explicitly forbids any agent abstraction (FR-003). No alternative framework introduced. Prerelease pinning unchanged: `*-core==1.0.0b251211`, `*-azure-ai==1.0.0b251211`.       |

All gates PASS. The single scope-narrowing decision (skip `Agent`/`ChatAgent`)
is recorded in Complexity Tracking with rationale.

### Post-design re-check (after Phase 1)

Re-evaluated after writing `research.md`, `data-model.md`,
`contracts/chatentry.openapi.yaml`, and `quickstart.md`:

- Three new module boundaries are each single-responsibility (Principle IV).
- No new third-party dependency added; Principle V surface is unchanged.
- Tool argument schemas are reused from `agents/tools/*` and merely
  *projected* into a JSON Schema for the LLM — single source of truth
  preserved (Principles I, IV).
- Determinism plan via `ChatClientProtocol` satisfies Principle II.
- No new gate violations introduced by the design. **Status: PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/005-direct-llm-chatentry/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # Feature spec (already exists)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── chatentry.openapi.yaml   # Phase 1 output (OpenAPI fragment)
├── checklists/
│   └── …                # (carried over from /speckit.specify; not edited here)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
backend/
├── src/momdiary/
│   ├── api/
│   │   ├── chatentry.py                # NEW — POST /v1/chatentry/ router
│   │   └── dependencies.py             # EDIT — expose get_chat_client + tool catalog
│   ├── services/
│   │   ├── chatentry_dispatcher.py     # NEW — ChatClientProtocol, prompt assembly,
│   │   │                               #       structured-output parsing, tool dispatch
│   │   └── chatentry_catalog.py        # NEW — project TOOL_REGISTRY tool args (Pydantic)
│   │                                   #       into a JSON Schema list for the LLM
│   ├── models/
│   │   └── schemas.py                  # EDIT — add ChatEntryRequest / ChatEntryResponse
│   │                                   #         + LLMDecision Pydantic models
│   ├── agents/
│   │   ├── diary_agent.py              # NO CHANGE (Agent path untouched)
│   │   ├── session_store.py            # NO CHANGE (reused for history when session_id supplied)
│   │   └── tools/                      # NO CHANGE (registry reused, both for catalog + invoke)
│   └── main.py                         # EDIT — register the new router
└── tests/
    ├── contract/
    │   └── test_chatentry_contract.py          # NEW — request/response envelope, OpenAPI pinning
    ├── integration/
    │   ├── test_chatentry_create_paths.py      # NEW — US1: one create per domain (fake LLM)
    │   ├── test_chatentry_correction.py        # NEW — US2: two-turn correction / delete
    │   ├── test_chatentry_clarification.py     # NEW — US3: ambiguous → clarification, no write
    │   ├── test_chatentry_malformed_llm.py     # NEW — malformed structured output → error, no write
    │   └── test_chatentry_session_reuse.py     # NEW — feature-003 SessionStore reuse
    └── unit/
        ├── test_chatentry_dispatcher.py        # NEW — decision parsing + dispatch branches
        ├── test_chatentry_catalog.py           # NEW — registry → JSON Schema projection
        └── test_chatentry_prompt.py            # NEW — prompt assembly + history trimming
```

**Structure Decision**: Web application — extend `backend/`. No frontend
changes in scope. New code is partitioned across `api/` (HTTP),
`services/` (LLM call, decision parsing, tool dispatch, catalog
projection), and `models/schemas.py` (Pydantic contracts). Tools and
their argument schemas live in the existing `agents/tools/*` modules and
are reused without modification. The session store from feature 003 is
imported and reused; no fork.

## Complexity Tracking

| Violation                                                  | Why Needed                                                                                                                                                                                                                                                                                                                                                                                                                          | Simpler Alternative Rejected Because                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Skip `Agent` / `ChatAgent` wrapper from MAF (Principle V scope-narrowing) | Spec FR-003 explicitly requires the endpoint to be implemented as a single LLM call + direct tool invocation, with no `Agent`/`ChatAgent` abstraction. Product reason: caregivers want a deterministic one-shot logging path that does not share the multi-turn loop, system prompt, or implicit retries of the conversational `/v1/entries` agent. The implementation still uses an MAF primitive (`AzureOpenAIChatClient`) — the framework boundary from Principle V is honored. | `ChatAgent` / `Agent` would meet Principle V more idiomatically, but it directly conflicts with the feature contract in FR-003 — they cannot both be satisfied. Building this endpoint on top of `ChatAgent` would also force us to disable / work around the agent's own tool-call loop to get one-shot semantics, which is more code, not less, and produces a worse abstraction match. The decision matches feature 004's precedent.                       |

**Prerelease versions consumed at implementation time** (per Principle V):
`agent-framework-core==1.0.0b251211`, `agent-framework-azure-ai==1.0.0b251211`.
The chat client is constructed via the same `_build_chat_client()` helper
shape used by `diary_agent.py` (re-exported from
`services/chatentry_dispatcher.py`); deployment / api-version changes in
the existing `Settings` propagate automatically.
