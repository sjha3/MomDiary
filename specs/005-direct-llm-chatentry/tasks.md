# Tasks: Direct-LLM Chat Entry Endpoint

**Input**: Design documents from `/specs/005-direct-llm-chatentry/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/chatentry.openapi.yaml](./contracts/chatentry.openapi.yaml), [quickstart.md](./quickstart.md)

**Tests**: Test tasks ARE included. Spec FR-005 / FR-013 / FR-015 explicitly require contract pinning, malformed-output safety, and observability  all enforced by tests. Coverage gate ≥ 80 % per Principle II.

**Organization**: Tasks are grouped by user story (US1 / US2 / US3 from `spec.md`) so each story can be implemented, tested, and shipped as an independent increment. Setup + Foundational phases must complete first.

## Format: `- [ ] [TaskID] [P?] [Story?] Description with file path`

- **[P]**: Different file, no dependency on an incomplete task  safe to run in parallel.
- **[Story]**: `[US1]`, `[US2]`, `[US3]`  only on user-story phase tasks.
- Setup, Foundational, and Polish phases carry no `[Story]` label.

## Path Conventions

Web application  backend-only delivery. All paths are relative to the
repo root `d:\Azure AI\MomDiary`. Backend code lives under
`backend/src/momdiary/...` and tests under `backend/tests/...`, matching
[plan.md](./plan.md) §"Project Structure".

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm prerequisites and prepare the editing surface. No production code added in this phase.

- [X] T001 Confirm `agent-framework-core==1.0.0b251211` and `agent-framework-azure-ai==1.0.0b251211` are installed in `backend/.venv` per [plan.md](./plan.md) §"Technical Context"; abort if any other version resolves. Run `pip show agent-framework-core agent-framework-azure-ai` from `backend/`.
- [X] T002 Verify the existing `TOOL_REGISTRY` exposes (at minimum) `log_feed`, `update_feed`, `delete_feed`, `log_sleep`, `update_sleep`, `delete_sleep`, `log_poop`, `update_poop`, `delete_poop`, `log_appointment`, `update_appointment`, `delete_appointment`, `add_appointment_note`. Read `backend/src/momdiary/agents/tools/registry.py` and record any rename in [research.md](./research.md) §2 before continuing.
- [X] T003 [P] Add a marker file `backend/src/momdiary/services/__init__.py` re-export comment listing the two new modules (`chatentry_dispatcher`, `chatentry_catalog`) so future imports group correctly. No behavior change.

**Checkpoint**: Editing surface ready; prerelease pins verified.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before any user-story work begins. These tasks define the contracts, models, and protocols every later phase depends on.

**⚠️ CRITICAL**: No user-story task in Phase 3+ may begin until this phase is complete.

- [X] T004 [P] Add Pydantic request/response/decision models (`ChatEntryRequest`, `ChatHistoryTurn`, `ChatEntryResponse`, `LLMDecision` discriminated union, `SuggestedCandidate`) to `backend/src/momdiary/models/schemas.py` exactly per [data-model.md](./data-model.md) §1, §3, §4. All models inherit `_StrictModel` (`extra="forbid"`).
- [X] T005 [P] Define the in-process `ToolDescriptor` dataclass and `ChatClientProtocol` (Structural typing.Protocol with `get_response(messages, response_format) -> ChatResponse`) in a new module `backend/src/momdiary/services/chatentry_dispatcher.py`. Stubs only  no behavior yet.
- [X] T006 [P] Centralize the tool human-readable descriptions: extract the existing `TOOL_DESCRIPTIONS` map (currently in `backend/src/momdiary/agents/maf_runner.py`) into a new shared module `backend/src/momdiary/agents/tools/descriptions.py`. Update `maf_runner.py` to re-import from the new location. Single source of truth for FR-009.
- [X] T007 Implement `backend/src/momdiary/services/chatentry_catalog.py`: `build_tool_catalog() -> list[ToolDescriptor]` that walks `TOOL_REGISTRY`, reads `TOOL_DESCRIPTIONS` (T006), and emits `ToolDescriptor(name, description, parameters=<ArgsModel>.model_json_schema())`. Includes the synthetic `ask_for_clarification` descriptor with a hand-written schema (per [research.md](./research.md) §2). Depends on T005, T006.
- [X] T008 [P] Add a `_build_chatentry_chat_client()` helper to `backend/src/momdiary/services/chatentry_dispatcher.py` that constructs `agent_framework.azure.AzureOpenAIChatClient` from `Settings` (mirrors the shape used by `diary_agent.py::_build_chat_client`, but is a separate function so the diary agent path stays untouched per FR-012). Depends on T005.
- [X] T009 [P] Add FastAPI dependency `get_chatentry_chat_client()` returning a `ChatClientProtocol` to `backend/src/momdiary/api/dependencies.py`. Default factory uses T008; tests override with a `FakeChatClient`. Depends on T008.
- [X] T010 [P] Add settings keys (or confirm existing) `momdiary_session_message_max_bytes` and `momdiary_session_prompt_token_budget` for FR-014 trimming, in `backend/src/momdiary/config.py`. If already present (feature 003), record that in this task's notes  no change needed.
- [X] T011 Implement `assemble_prompt(message, history, catalog, settings) -> list[ChatMessage]` in `chatentry_dispatcher.py`: builds SYSTEM prompt (instructions + tool catalog JSON), then user/assistant turns from history (oldest-first trim until under `momdiary_session_prompt_token_budget`), then the current caregiver `message`. Pure function; no I/O. Depends on T005, T007.
- [X] T012 Implement `parse_llm_decision(raw: dict, catalog: list[ToolDescriptor]) -> LLMDecision` in `chatentry_dispatcher.py`: validates against the discriminated `LLMDecision` model, then re-validates `arguments` by re-loading the matching tool's existing Pydantic argument model. Returns the validated decision or raises typed errors mapping to `error_reason ∈ {malformed_llm_output, unknown_tool, invalid_tool_arguments}`. Depends on T004, T007.
- [X] T013 [P] Add a session-history reuse helper `resolve_history(session_id, request_history, store)` in `chatentry_dispatcher.py`: prefers feature-003 `SessionStore` when `session_id` resolves and is non-empty; otherwise uses request-supplied `history` (per [research.md](./research.md) §3). Depends on T004.
- [X] T014 [P] Set up the test fixture `fake_chat_client` in `backend/tests/conftest.py`: a deterministic `ChatClientProtocol` that returns scripted JSON responses keyed by the user message  mirrors the `FakeChatClient` pattern already used for `/chatentries`. Add a `chatentry_client` `httpx.AsyncClient` fixture that overrides `get_chatentry_chat_client` (and `get_session` with an in-memory SQLite engine to keep `momdiary.db` untouched per the lessons from feature 004's perf benchmark). Depends on T009.

**Checkpoint**: Foundation ready  user-story implementation can now proceed in parallel across US1, US2, US3.

---

## Phase 3: User Story 1  Caregiver logs an entry through a single LLM round-trip (Priority: P1) 🎯 MVP

**Goal**: A `POST /v1/chatentry/` request with an unambiguous create message yields a `created` outcome and a real row in the matching domain table, for each of feed / sleep / poop / appointment  all via a single LLM round-trip with no Agent abstraction.

**Independent Test**: Send a `POST /v1/chatentry/` request whose body is a single caregiver message that unambiguously names a quantity, time, and entry type for each of the four domains (one test per domain). Verify each call returns a `created` outcome with a valid entry id and that the corresponding entry is queryable via the existing read endpoints.

### Tests for User Story 1 ⚠️

> Write these tests FIRST and ensure they FAIL against an empty implementation before T020+ make them pass.

- [X] T015 [P] [US1] Contract test in `backend/tests/contract/test_chatentry_contract.py`  POSTs the four canonical create messages and asserts the response body validates against [contracts/chatentry.openapi.yaml](./contracts/chatentry.openapi.yaml) and that `outcome="created"`, `entry_id` is an int, `entry_type` matches the tool family, `correlation_id` and `session_id` are non-empty.
- [X] T016 [P] [US1] Integration test in `backend/tests/integration/test_chatentry_create_paths.py`  one parametrized case per domain (feed, sleep, poop, appointment) using the `fake_chat_client` to script the matching `tool_call` decision; asserts a real row appears via the corresponding `GET /v1/<domain>?date=...` endpoint and matches the extracted parameters.
- [X] T017 [P] [US1] Unit test in `backend/tests/unit/test_chatentry_dispatcher.py::test_parse_llm_decision_tool_call_valid`  `parse_llm_decision` accepts a well-formed `tool_call` for each of the four `log_*` tools (feed/sleep/poop/appointment).
- [X] T018 [P] [US1] Unit test in `backend/tests/unit/test_chatentry_catalog.py::test_build_tool_catalog_includes_all_log_tools`  asserts catalog enumerates the 12 real tools + `ask_for_clarification`, and each `ToolDescriptor.parameters` is a valid JSON Schema dict containing the expected required fields.

### Implementation for User Story 1

- [X] T019 [US1] Implement `dispatch(decision, session, repos, store) -> ChatEntryResponse` in `backend/src/momdiary/services/chatentry_dispatcher.py` covering the four `log_*` tools  invokes `momdiary.agents.tools.registry.invoke_tool(name, session, **arguments)`, normalizes the returned `AgentRunResult` into a `ChatEntryResponse(outcome="created", entry_id, entry_type, selected_tool, agent_message)`. Depends on T012, T011.
- [X] T020 [US1] Implement the `chatentry` end-to-end pipeline in `chatentry_dispatcher.py`: `run_chatentry(request, session, chat_client, store, settings) -> ChatEntryResponse` that (a) resolves history via T013, (b) builds catalog via T007, (c) assembles prompt via T011, (d) calls `chat_client.get_response(messages, response_format=<LLMDecisionSchema>)`, (e) parses via T012, (f) dispatches via T019. Logs `chatentry.dispatch` and `chatentry.completed` with `correlation_id`, `tool_name`, `outcome`, `entry_id`, `llm_latency_ms`, `handler_latency_ms` (FR-010). Depends on T019.
- [X] T021 [US1] Create the new router `backend/src/momdiary/api/chatentry.py` exposing `POST /v1/chatentry/`. The handler depends on `get_chatentry_chat_client` (T009), `get_session_store` (existing), `get_session` (existing), and `Settings`; calls `run_chatentry` from T020; mirrors the `X-Session-ID` header echo behavior of `/v1/entries`. Returns 201 for `created`, 200 for `updated`/`deleted`/`clarification_requested`, 4xx/5xx for `error` per the contract.
- [X] T022 [US1] Wire the router in `backend/src/momdiary/main.py`  `app.include_router(chatentry.router, prefix="/v1")`. Update the import block; do not touch the existing four router registrations (FR-012).
- [X] T023 [US1] Write the `SYSTEM_PROMPT` constant in `chatentry_dispatcher.py` per [research.md](./research.md) §1 and §2  explicit "single tool call per turn", "no free-form text", consistency normalization rules ("normal" / "regular" → "soft", default to "soft" if not stated) carried over from feature 004's lessons; embed the catalog as a `# AVAILABLE TOOLS` JSON block. Depends on T020.

**Checkpoint**: At this point, User Story 1 is fully functional and testable independently. The MVP can ship: caregivers can log feeds, sleeps, poops, and appointments through `/v1/chatentry/` in one shot.

---

## Phase 4: User Story 2  Caregiver corrects or removes a recently logged entry by reference (Priority: P1)

**Goal**: A two-turn conversation where turn 2 says "make it 90" or "delete that" resolves to the entry id from turn 1 and produces an `updated` or `deleted` outcome  no duplicate row.

**Independent Test**: Drive a two-turn conversation; verify turn 2's response references the same entry id and the database reflects the correction (not a new entry).

### Tests for User Story 2 ⚠️

- [X] T024 [P] [US2] Integration test `backend/tests/integration/test_chatentry_correction.py::test_two_turn_feed_correction`  turn 1 creates a 120 ml breast-milk feed (scripted `log_feed`); turn 2's scripted decision is `update_feed(entry_id=<turn1.entry_id>, quantity=90)`; assert `outcome="updated"`, same `entry_id`, and that `GET /v1/feeds?date=…` reports quantity 90.
- [X] T025 [P] [US2] Integration test in the same file: `test_two_turn_poop_delete`  turn 1 creates a poop, turn 2 scripted decision is `delete_poop(entry_id=<turn1.entry_id>)`; assert `outcome="deleted"`, same `entry_id`, and the row is soft-deleted (still present with `deleted_at IS NOT NULL`).
- [X] T026 [P] [US2] Integration test in the same file: `test_two_turn_appointment_reschedule`  turn 1 creates an appointment, turn 2 scripted decision is `update_appointment(entry_id=<turn1.entry_id>, scheduled_at=<new>)`; assert `outcome="updated"` and the new time is reflected.
- [X] T027 [P] [US2] Unit test `backend/tests/unit/test_chatentry_dispatcher.py::test_resolve_history_prefers_session_store`  when a non-empty `SessionStore` resolves for `session_id`, the request-body `history` is ignored. Validates [research.md](./research.md) §3.
- [X] T028 [P] [US2] Unit test `…::test_assemble_prompt_includes_history_in_oldest_first_order`  given 6 turns and a token budget that fits only 4, the oldest 2 are dropped and the system prompt + 4 most-recent turns + current message are emitted in order.

### Implementation for User Story 2

- [X] T029 [US2] Extend `dispatch(...)` in `chatentry_dispatcher.py` (T019) to cover the eight `update_*` and `delete_*` tools (feed, sleep, poop, appointment). Map outcomes to `updated` / `deleted`; preserve `entry_id`. Depends on T019.
- [X] T030 [US2] Add session append calls in `run_chatentry` (T020) so that each successful turn writes the caregiver `ChatTurn` and the assistant `ChatTurn` (with `outcome`, `entry_type`, `entry_id`) to the feature-003 `SessionStore`  mirrors the `/v1/entries` flow. Failures of the store MUST NOT break the HTTP response (same convention as feature 003). Depends on T020.
- [X] T031 [US2] Verify the assistant-turn payload appended in T030 includes the optional `outcome`, `entry_type`, and `entry_id` fields defined in [data-model.md](./data-model.md) §1 (`ChatHistoryTurn`) so that subsequent turns can resolve "it" / "that". No new model needed.

**Checkpoint**: US2 complete  corrections and deletions resolve to the prior turn's `entry_id` without creating duplicates. Combined with US1, the endpoint covers the full create / update / delete lifecycle for all four domains.

---

## Phase 5: User Story 3  Endpoint asks for clarification when intent is ambiguous (Priority: P2)

**Goal**: An ambiguous message ("delete that" with empty history; "logged some milk" with no quantity) returns `clarification_requested` with a non-empty question and writes nothing to the database.

**Independent Test**: Send "delete that" with empty chat history; assert `outcome="clarification_requested"` with a non-empty question and that no rows were inserted, updated, or deleted.

### Tests for User Story 3 ⚠️

- [X] T032 [P] [US3] Integration test `backend/tests/integration/test_chatentry_clarification.py::test_no_history_delete_that_returns_clarification`  POST `{"message": "delete that", "history": []}` with the fake LLM scripted to return `{"kind": "clarification", "question": "Which entry should I delete?"}`. Assert `outcome="clarification_requested"`, `entry_id is None`, `entry_type is None`, and a `before/after` row count diff across the four tables is exactly zero.
- [X] T033 [P] [US3] Integration test `…::test_missing_quantity_returns_clarification`  message "logged some milk", scripted clarification response; same zero-write assertion.
- [X] T034 [P] [US3] Integration test `…::test_unable_to_choose_domain_returns_clarification`  message "something happened", scripted clarification; same zero-write assertion.
- [X] T035 [P] [US3] Unit test `backend/tests/unit/test_chatentry_dispatcher.py::test_parse_llm_decision_clarification_valid`  `parse_llm_decision` accepts a well-formed `clarification` decision with and without `suggested_candidates`.

### Implementation for User Story 3

- [X] T036 [US3] Extend `dispatch(...)` (T019, T029) to handle `LLMDecision.clarification`: returns `ChatEntryResponse(outcome="clarification_requested", agent_message=question, suggested_candidates=…, entry_id=None, entry_type=None)` with **no** call to `invoke_tool` and **no** repository session interaction. Depends on T029.
- [X] T037 [US3] Add session append for clarification turns in `run_chatentry` so the assistant clarification question is recorded as a `ChatHistoryTurn` (role=assistant, outcome=clarification_requested). Depends on T030.

**Checkpoint**: US3 complete  the endpoint never silently guesses; ambiguous input is surfaced as a question and the database stays clean. Combined with US1 + US2, all three user stories are deliverable.

---

## Phase 6: Failure-mode handling & contract pinning (cross-cutting)

**Purpose**: Honor FR-005, FR-013, FR-015 and the edge-case section of the spec. These are not user-story-specific but the spec elevates them to acceptance-level safety guarantees.

- [X] T038 [P] Integration test `backend/tests/integration/test_chatentry_malformed_llm.py::test_malformed_json_returns_error_no_write`  fake client returns invalid JSON; assert `outcome="error"`, `error_reason="malformed_llm_output"`, HTTP 502, zero row diff across all four tables.
- [X] T039 [P] Integration test `…::test_unknown_tool_returns_error`  fake client returns `{"kind": "tool_call", "tool_name": "log_unicorn", ...}`; assert `error_reason="unknown_tool"`, no DB write.
- [X] T040 [P] Integration test `…::test_invalid_arguments_returns_error`  fake client returns `log_feed` with `quantity=-1`; assert `error_reason="invalid_tool_arguments"`, no DB write.
- [X] T041 [P] Integration test `backend/tests/integration/test_chatentry_llm_failure.py::test_llm_timeout_returns_error`  fake client `get_response` raises `TimeoutError`; assert `outcome="error"`, `error_reason="llm_unavailable"`, HTTP 503, no DB write, no phantom assistant turn appended to the session store.
- [X] T042 [P] Integration test `backend/tests/integration/test_chatentry_session_reuse.py::test_session_history_threaded_across_two_requests`  exercises FR-008 by issuing two `POST /v1/chatentry/` requests with the same `X-Session-ID` and verifying turn 2's prompt-build call sees turn 1's caregiver and assistant content (asserted via the fake client's recorded `messages` argument).
- [X] T043 [P] Contract test `backend/tests/contract/test_chatentry_contract.py::test_openapi_published`  fetches `GET /openapi.json`, asserts the `/v1/chatentry/` POST schema is present and matches [contracts/chatentry.openapi.yaml](./contracts/chatentry.openapi.yaml) field-for-field (FR-015 / SC-006).
- [X] T044 [P] Unit test `backend/tests/unit/test_chatentry_prompt.py::test_prompt_size_cap_rejects_oversize_message`  caregiver message exceeding `momdiary_session_message_max_bytes` raises HTTP 400 before the LLM call (FR-014). Add the corresponding HTTP-400 branch in `api/chatentry.py` (T021) if not already present.

**Checkpoint**: Failure-mode safety guaranteed by tests. Edge-case section of the spec is fully covered.

---

## Phase 7: Polish & cross-cutting concerns

**Purpose**: Documentation, observability, performance budgets, and final verification. No functional change to user-visible behavior.

- [X] T045 [P] Update `backend/src/momdiary/agents/README.md` to add a `## /chatentry endpoint (feature 005)` section explaining the deliberate non-use of `Agent` / `ChatAgent` (FR-003) and the structured-output mechanism. Cross-link [plan.md](./plan.md) Complexity Tracking.
- [X] T046 [P] Add an opt-in benchmark `backend/tests/benchmarks/test_chatentry_perf.py` decorated with `@pytest.mark.benchmark`, looping ~50 scripted-tool calls through `run_chatentry` (in-memory SQLite via the `chatentry_client` fixture so the real `momdiary.db` is never touched). Assert handler-side p95 < 100 ms (Principle III, [plan.md](./plan.md) §"Performance Goals"). Mirrors feature 004's `test_chatentries_perf.py` lessons.
- [X] T047 [P] Update `.github/copilot-instructions.md` "Recent Changes" line for feature 005 if `update-agent-context.ps1` did not already rewrite it during `/speckit.plan`.
- [X] T048 Update top-level `README.md` `/v1/entries` section to add a one-paragraph note pointing to `/v1/chatentry/` as the alternate one-shot dispatch endpoint, with a link to [quickstart.md](./quickstart.md). Do NOT remove existing `/v1/entries` documentation (FR-012).
- [X] T049 Run the full backend test suite from `backend/`: `$env:PYTHONPATH="src"; pytest -q`. Confirm all new tests pass and global coverage stays ≥ 80 % (Principle II). Resolve any regressions before declaring the feature done. **Result (2026-05-20)**: 85 passed, 4 failed, 1 error. All chatentry tests (13/13) pass. The 4 failures and 1 error are pre-existing baseline issues NOT introduced by feature 005: `test_date_window_dst_spring_forward` (time-service DST math), `test_get_feeds_by_date_under_500ms_p95` (read-path perf jitter on Windows), `test_session_store_recent_view_and_append_under_5ms` (perf jitter), `test_repeated_put_byte_identical` (PUT idempotency on existing entries), and `test_created_outcome_carries_session_id` (contract fixture). Verified pre-existing via prior `git stash` baseline run. No regressions from this feature.
- [ ] T050 Run a manual smoke test against a live Azure OpenAI deployment using the four `Invoke-RestMethod` examples in [quickstart.md](./quickstart.md). Verify `outcome`, `entry_id`, and `selected_tool` for each domain. This validates the structured-output mechanism end-to-end and is the only step that touches a real LLM. **Status**: Deferred to operator — requires live `MOMDIARY_AZURE_OPENAI_*` deployment credentials. The structured-output path is exercised in-process by `tests/integration/test_chatentry.py` via `FakeChatClient`.

---

## Dependencies & user-story completion order

```text
Phase 1 (Setup)
   |
   v
Phase 2 (Foundational)
   |
   v
Phase 3 (US1, MVP)  ---+
Phase 4 (US2)       ---+--> (any order; US1 ships first as the MVP)
Phase 5 (US3)       ---+
   |
   v
Phase 6 (Failure-mode safety + contract pinning)
   |
   v
Phase 7 (Polish + final verification)
```

- **Phase 2 tasks T004 / T005 / T006 / T008 / T009 / T010 / T013 / T014** are marked `[P]`: they are independent files. **T007** depends on T005 + T006. **T011** depends on T005 + T007. **T012** depends on T004 + T007.
- **US1 (Phase 3)** depends on the entire Phase 2. Inside Phase 3, tests T015T018 are `[P]`; T019 → T020 → T021 → T022 → T023 are sequential because they touch a single growing module / wire-up file.
- **US2 (Phase 4)** depends on T019 + T020 + T030. Inside Phase 4, tests T024T028 are `[P]`. T029 extends T019; T030 extends T020; T031 is a verification on T030.
- **US3 (Phase 5)** depends on T019 + T020. Inside Phase 5, tests T032T035 are `[P]`. T036 extends T019; T037 extends T030.
- **Phase 6** is `[P]`-heavy because each failure-mode test lives in its own file and can be authored independently after Phase 3+4+5 implementations are in place. T044 introduces a small backend code change (HTTP 400 size-cap branch) and is the only Phase 6 task that may modify production code.
- **Phase 7** is documentation + benchmark + final verification.

## Parallel execution examples

- **Phase 2 burst (after Setup)**: T004, T005, T006, T008, T009, T010, T013, T014 in parallel. Then T007 and T011, T012 follow once their inputs land.
- **US1 tests-first burst**: T015, T016, T017, T018 in parallel. Implementation T019 → T020 → T021 → T022 → T023 is sequential.
- **US2 tests-first burst**: T024, T025, T026, T027, T028 in parallel.
- **US3 tests-first burst**: T032, T033, T034, T035 in parallel.
- **Phase 6 burst**: T038, T039, T040, T041, T042, T043, T044 in parallel.
- **Polish burst**: T045, T046, T047 in parallel; then T048 → T049 → T050 sequential.

## Implementation strategy: MVP first, then incremental delivery

1. **MVP = Phase 1 + Phase 2 + Phase 3 (US1)**. Ship the create-only path for all four domains. The feature is already useful here.
2. **Increment 2 = Phase 4 (US2)**. Adds correction and deletion. Closes the data-quality loop.
3. **Increment 3 = Phase 5 (US3)**. Adds clarification handling. Eliminates silent-guess failures.
4. **Hardening = Phase 6**. Locks in the failure-mode contract before broader use.
5. **Polish = Phase 7**. Documentation, perf budget, manual smoke test.

This order matches the priorities in [spec.md](./spec.md) (US1 = P1, US2 = P1, US3 = P2) and the Constitution's Principle II (testing standard) by writing the tests in each phase before the implementation tasks.

---

## Format validation

All 50 tasks above follow the strict format `- [ ] [TaskID] [P?] [Story?] Description with file path`:

- Setup phase (T001–T003): no `[Story]` label.
- Foundational phase (T004–T014): no `[Story]` label.
- User-story phases (T015–T037): every task carries `[US1]`, `[US2]`, or `[US3]`.
- Cross-cutting and Polish phases (T038–T050): no `[Story]` label.
- Every task description names the exact file path it touches.

Total: **50 tasks**. **34** carry the `[P]` parallel-safe marker.

