# Feature Specification: Direct-LLM Chat Entry Endpoint

**Feature Branch**: `005-direct-llm-chatentry`
**Created**: 2026-05-20
**Status**: Draft
**Input**: User description: "Add an api chatentry/ which takes users query and makes addition/update/deletion in all entries like feed, poop, appointment, sleep. It passes chat history, user query and tool information to LLM and expects a structured response from LLM which provides information of tool to be invoked and extracted parameters from user query. Based on this response, actual tool is executed and entry is added/updated/deleted. DO NOT use any AGENT for this purpose."

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Caregiver logs an entry through a single LLM round-trip (Priority: P1)

A caregiver opens the app, types a free-form message such as "Liam had 120 ml of breast milk just now" into the chat surface, and the new endpoint creates the matching feed entry in one shot — without going through the existing agent runner. The response confirms the entry was logged and tells the user what was recorded.

**Why this priority**: This is the core promise of the feature. It demonstrates that a thin, direct-LLM dispatcher (no Agent/ChatAgent abstraction) can correctly classify the caregiver's intent across the four entry domains (feed, sleep, poop, appointment), extract structured parameters, and route to the correct write tool. If only this story ships, caregivers can already log every kind of entry through chat.

**Independent Test**: Send a `POST /v1/chatentry/` request whose body is a single caregiver message that unambiguously names a quantity, time, and entry type for each of the four domains (one test per domain). Verify each call returns a `created` outcome with a valid entry id and that the corresponding entry is queryable via the existing read endpoints.

**Acceptance Scenarios**:

1. **Given** an empty database and a fresh chat session, **When** the caregiver sends "120 ml breast milk just now", **Then** the response reports a `created` outcome carrying a feed entry id and the feeds table contains exactly one feed of 120 ml at the current time.
2. **Given** an empty database and a fresh chat session, **When** the caregiver sends "Liam slept from 1pm to 3pm", **Then** the response reports `created` and the sleeps table contains a sleep entry spanning the requested window.
3. **Given** an empty database and a fresh chat session, **When** the caregiver sends "He had a yellow seedy poop 10 minutes ago", **Then** the response reports `created` and the poops table contains a corresponding entry.
4. **Given** an empty database and a fresh chat session, **When** the caregiver sends "Pediatrician appointment next Tuesday at 10am", **Then** the response reports `created` and the appointments table contains a matching entry.

---

### User Story 2 — Caregiver corrects or removes a recently logged entry by reference (Priority: P1)

A caregiver who just logged a feed says "actually make it 90 ml" or "delete that". The endpoint resolves the reference using the chat history passed in the request, calls the matching update or delete tool, and returns an `updated` or `deleted` outcome that points at the same entry id from the prior turn — no duplicate row is created.

**Why this priority**: Addition alone is not enough — caregivers correct themselves constantly. Update and delete close the loop on data quality and prove that chat history + structured LLM output is sufficient to disambiguate which prior entry the user means. Same priority as US1 because together they constitute the MVP for the new endpoint.

**Independent Test**: Drive a two-turn conversation where turn 1 is a clear log message and turn 2 is a correction or removal phrased as a follow-up ("make it 90", "delete that"). Verify turn 2's response references the same entry id and that the database reflects the correction (not a new entry).

**Acceptance Scenarios**:

1. **Given** the previous assistant turn confirmed a feed of 120 ml with entry id E, **When** the caregiver sends "make it 90", **Then** the response reports `updated` for entry id E and the feed row's amount is 90 ml.
2. **Given** the previous assistant turn confirmed a poop entry with id P, **When** the caregiver sends "delete that", **Then** the response reports `deleted` for entry id P and the poop row is soft-deleted.
3. **Given** chat history containing a single appointment created in the last turn, **When** the caregiver sends "move it to Wednesday at 11", **Then** the response reports `updated` for that appointment and the appointment row's start time is the requested Wednesday at 11:00 local.

---

### User Story 3 — Endpoint asks for clarification when intent is ambiguous (Priority: P2)

A caregiver sends a vague message such as "delete that" with no chat history, or "logged some milk" with no quantity. The endpoint does not guess; it returns a clarification outcome carrying a question for the caregiver and does not write to the database.

**Why this priority**: Critical for data integrity but not required to demo the happy paths. Without it the system would silently create wrong entries or fail uninformatively. Lower priority than US1/US2 because the MVP can ship with strict happy-path coverage and incrementally add clarifications.

**Independent Test**: Send "delete that" with empty chat history; assert response is `clarification_requested` with a non-empty question and that no rows were inserted, updated, or deleted.

**Acceptance Scenarios**:

1. **Given** an empty chat history, **When** the caregiver sends "delete that", **Then** the response reports `clarification_requested` and no entry is modified.
2. **Given** the caregiver sends "logged some milk" with no quantity, **When** the request is processed, **Then** the response reports `clarification_requested` and prompts for the missing quantity.
3. **Given** the LLM cannot confidently choose among feed/sleep/poop/appointment for the input, **When** the request is processed, **Then** the response reports `clarification_requested` rather than picking one at random.

---

### Edge Cases

- **LLM returns malformed structured output** (missing fields, wrong types, hallucinated tool name not in the catalog): the endpoint MUST reject the LLM response, return a typed error to the client, and MUST NOT write to the database. The error MUST be logged with enough detail to diagnose model drift.
- **LLM names a tool outside the supported catalog**: treated as malformed output (above). The endpoint MUST NOT attempt to invoke an unknown tool.
- **LLM extracts parameters that fail the tool's input validation** (e.g., negative volume, end-time before start-time): the endpoint surfaces the validation error to the client as a clarification or error outcome and MUST NOT persist a partial entry.
- **Conversation history exceeds the model's context window**: the request is trimmed (oldest turns first) until it fits; no request is rejected solely for being too long unless the current turn alone exceeds the per-message size cap.
- **LLM call fails or times out**: the endpoint returns a typed error response; no entry is written and the chat history is not corrupted by a phantom assistant turn.
- **Concurrent requests from the same caregiver**: each request is processed independently; consistency of the underlying entry tables is the responsibility of the existing tools, which already handle this for feature 001.
- **Tool catalog drift**: if a tool is added to or removed from the registry, the endpoint MUST surface the up-to-date catalog to the LLM on every call so the model never references a stale tool name.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a new HTTP endpoint at `POST /v1/chatentry/` that accepts a caregiver message, an optional chat history, and an optional session identifier, and returns a structured response describing the outcome.
- **FR-002**: The endpoint MUST cover all four entry domains in scope today — feed, sleep, poop, and appointment — supporting create, update, and delete operations for each.
- **FR-003**: The endpoint MUST NOT use any Agent or ChatAgent abstraction; it MUST call the underlying chat-completion model directly with a single prompt assembled from the caregiver query, the chat history, and the tool catalog.
- **FR-004**: The endpoint MUST require the LLM to return a structured response (not free-form text) that names exactly one tool from the catalog and provides the parameters needed to invoke it, or names a clarification action with a question.
- **FR-005**: The endpoint MUST validate the LLM's structured response against the tool catalog before dispatching: unknown tool names, missing required parameters, or parameters of the wrong shape MUST be rejected without a database write.
- **FR-006**: The endpoint MUST execute the named write tool against the existing repository layer used by feature 001 so that data semantics (soft delete, idempotency, validation) remain identical to the existing entry endpoints.
- **FR-007**: The endpoint MUST return a structured response that distinguishes the outcomes `created`, `updated`, `deleted`, `clarification_requested`, and `error`, and MUST include the affected entry id whenever applicable.
- **FR-008**: The endpoint MUST accept chat history sufficient for the LLM to resolve references like "it" or "that" to a previously discussed entry, and MUST NOT require the caregiver to repeat prior context on every correction.
- **FR-009**: The endpoint MUST surface the full tool catalog (tool names, parameter shapes, and a short description of each) to the LLM on every call so the model decision is grounded in the live registry rather than a stale snapshot.
- **FR-010**: The endpoint MUST log every LLM call and every tool dispatch (tool name, outcome, entry id, latency) using the existing structured logger, so operators can audit decisions and diagnose drift.
- **FR-011**: The endpoint MUST handle clarification cases without writing to the database: if the LLM cannot confidently pick a tool or extract required parameters, the response carries a question for the caregiver and the database is unchanged.
- **FR-012**: The endpoint MUST NOT degrade existing endpoints. The pre-existing chat-write endpoint and entry endpoints (created in features 001, 003, 004) MUST continue to function unchanged.
- **FR-013**: The endpoint MUST treat each LLM call as best-effort: on LLM timeout, transport error, or malformed output, the endpoint MUST return an `error` outcome with a typed reason and MUST NOT retry destructively (e.g., MUST NOT replay a delete it cannot confirm completed).
- **FR-014**: The endpoint MUST cap the per-request caregiver message size and the total prompt size at configurable limits, and MUST trim oldest chat-history turns first when the prompt would exceed the model's context window.
- **FR-015**: The endpoint MUST be observable from the existing OpenAPI surface — the request and response schemas MUST be published in the OpenAPI document so contract tests can pin the contract.

### Key Entities *(include if feature involves data)*

- **ChatEntryRequest**: The HTTP payload — the caregiver's current message, the chat history (list of prior caregiver/assistant turns), and an optional session identifier. Read-only from the endpoint's perspective; not persisted by this feature.
- **ToolDescriptor**: A single entry in the catalog passed to the LLM, naming the tool (e.g., `log_feed`), its parameter shape, and a one-line description. Sourced from the existing tool registry; not new state.
- **LLMDecision**: The structured response the LLM is required to return — a chosen tool name plus the parameters extracted from the caregiver's query, or a clarification action with a question. Validated and discarded after dispatch; not persisted as a row.
- **ChatEntryResponse**: The HTTP response — the outcome (`created` / `updated` / `deleted` / `clarification_requested` / `error`), the affected entry id when applicable, the assistant message shown to the caregiver, and a session identifier echoed back to the client.
- **Entry (Feed / Sleep / Poop / Appointment)**: The pre-existing domain rows. This feature reuses their schemas and repositories without alteration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For each of the four entry domains, an unambiguous create message ("120 ml breast milk just now", "slept 1pm to 3pm", "yellow seedy poop 10 minutes ago", "pediatrician next Tuesday at 10am") yields a `created` outcome and a matching database row in at least 95% of attempts on a curated benchmark of 20 prompts per domain.
- **SC-002**: For a corpus of 30 two-turn correction prompts (where turn 2 references turn 1 with "it"/"that"/"actually …"), the endpoint produces an `updated` or `deleted` outcome that targets the same entry id from turn 1 in at least 90% of cases — without creating a duplicate row.
- **SC-003**: For a corpus of 20 deliberately ambiguous prompts (no quantity, no antecedent, contradictory units), the endpoint returns `clarification_requested` in at least 95% of cases and writes nothing to the database.
- **SC-004**: When the LLM returns malformed output (simulated via a fault-injection test), the endpoint returns an `error` outcome and the four entry tables show zero new rows in 100% of attempts.
- **SC-005**: The median end-to-end latency of a successful `POST /v1/chatentry/` call is under 3 seconds on the development LLM deployment, and the 95th-percentile latency is under 6 seconds.
- **SC-006**: The endpoint's contract is reflected in the OpenAPI document and pinned by a contract test that fails if the request or response schema changes without intent.

## Assumptions

- The existing tool registry (`log_feed`, `update_feed`, `delete_feed`, and the equivalents for sleep/poop/appointment, plus `add_appointment_note`) is the authoritative catalog. This feature reuses it as the source of truth and does not introduce new tools.
- Soft-delete, idempotency, validation, and time-zone handling are inherited from the feature-001 repositories. This feature is a new dispatch path, not a new data layer.
- The chat history is supplied by the client on each request (consistent with feature 002's frontend chat pattern) or pulled from the in-process session store added in feature 003 when a session id is supplied. Persistent multi-process session storage is out of scope.
- The caregiver is authenticated by the same mechanism (or lack thereof) as the existing endpoints; no new auth model is introduced. The v1 lack of auth is documented as a known limitation, not a regression.
- The underlying chat model supports a structured-output mechanism (e.g., JSON schema / function-calling style response). The endpoint does not need a model-specific fallback parser for free-form text; if the model returns free-form text, that is treated as malformed output per FR-005.
- The endpoint runs in the same FastAPI process as the existing endpoints and reuses the same database session dependency, structured logger, and configuration loader.
- Performance targets in SC-005 are measured against the development Azure OpenAI deployment used by features 001–004; production tuning is out of scope for this spec.
- Read-only conversational queries ("what did I log today?") are out of scope for this endpoint; this endpoint's job is write dispatch. Read access continues through the existing entry endpoints.

## Out of Scope

- Any change to the existing `/v1/entries` chat-write endpoint or to the agent runner introduced in feature 001.
- Any change to feature 004's `/chatentries` endpoint, if present. This new `/v1/chatentry/` endpoint is an independent dispatch path and may coexist.
- Multi-process or persistent session storage. The in-process session store from feature 003 is reused as-is when a session id is supplied.
- New entry domains beyond feed, sleep, poop, and appointment.
- Frontend UI changes. This spec is backend-only; a follow-up spec may wire the new endpoint into the chat surface.
- Authentication, authorization, or per-caregiver data partitioning — inherited from the v1 baseline.
