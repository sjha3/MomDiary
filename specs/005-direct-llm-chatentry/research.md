# Phase 0 Research — Direct-LLM Chat Entry Endpoint

**Feature**: `005-direct-llm-chatentry`
**Date**: 2026-05-20
**Status**: Complete (no NEEDS CLARIFICATION remaining in spec; this
document records the design decisions on top of an already-clarified
spec).

## Scope of research

The feature spec contains zero `[NEEDS CLARIFICATION]` markers — the
caregiver-facing behavior, the four entry domains, the five outcomes, and
the success criteria are already pinned. Phase 0 therefore concentrates
on **engineering decisions** that the plan must commit to before Phase 1:

1. Which mechanism produces the LLM's structured response.
2. How the live tool catalog is represented to the LLM.
3. How chat history is sourced (request body vs. feature-003 session
   store) and trimmed.
4. How Principle V's "Microsoft Agent Framework first" rule is honored
   while still satisfying FR-003 ("MUST NOT use any Agent or ChatAgent
   abstraction").
5. How the integration tests stay deterministic (Principle II) without
   live-model calls.
6. Failure-mode taxonomy that maps to the five `outcome` values
   (`created` / `updated` / `deleted` / `clarification_requested` /
   `error`).

Each section below records the **Decision**, **Rationale**, and
**Alternatives considered**.

---

## 1. LLM structured-output mechanism

**Decision**: Use Azure OpenAI's *JSON-mode with a JSON Schema*
(`response_format = {"type": "json_schema", "json_schema": {...}}`)
through `AzureOpenAIChatClient.get_response(messages=..., response_format=...)`.
The schema describes a single discriminated union with two branches:

```jsonc
// LLMDecision (one of)
{ "kind": "tool_call",      "tool_name": "log_feed", "arguments": { ... } }
{ "kind": "clarification",  "question": "How many ml?",
  "suggested_candidates": [ ... ]  // optional
}
```

`tool_name` is constrained to an `enum` containing exactly the names
present in `TOOL_REGISTRY` at request time (plus the literal
`ask_for_clarification` mapped onto the `clarification` branch). The
`arguments` sub-schema is built per-call by projecting the existing
Pydantic argument models in `agents/tools/feeds.py`,
`agents/tools/sleeps.py`, etc.

**Rationale**:

- Eliminates the brittle "parse free-form text" fallback FR-005 forbids:
  any non-conforming output is a model-side validation failure surfaced
  by the API, and the dispatcher rejects it as malformed (edge-case
  "LLM returns malformed structured output").
- The same `AzureOpenAIChatClient` already used by the diary agent
  supports `response_format` natively in the December-2025 beta line
  (`agent-framework-azure-ai==1.0.0b251211`), so no new dependency.
- Keeps the dispatcher model-portable: any chat client that implements
  the in-house `ChatClientProtocol` can substitute a different
  structured-output backend without touching the HTTP layer.

**Alternatives considered**:

- *OpenAI function-calling (`tools=[...]` + `tool_choice`)*: viable, but
  the response shape is a per-tool partial that the model can also
  decline to call — and FR-003 forbids any iteration loop. JSON-schema
  mode is a single, total response and is a better fit for one-shot
  dispatch. (Feature 004's plan picked function-calling; we deliberately
  diverge because feature 004 used the rc6 line and supported its tool
  shape, while we keep one canonical decision schema.)
- *Free-form JSON in a system prompt*: rejected — too easy for the model
  to drift; FR-005 requires structured output.
- *Two-call pattern (classifier → extractor)*: rejected — doubles
  latency and violates the "single LLM round-trip" promise of the
  feature title.

---

## 2. Tool catalog representation

**Decision**: At request time, project the live `TOOL_REGISTRY` into a
list of `ToolDescriptor` records. Each descriptor carries:

- `name` — the registry key (e.g., `log_feed`).
- `description` — copied verbatim from `TOOL_DESCRIPTIONS` in
  `agents/maf_runner.py` (single source of truth — moved into a small
  shared module so both runners share it).
- `parameters` — a JSON Schema generated from the existing Pydantic
  argument model (`LogFeedArgs`, `UpdateFeedArgs`, `DeleteFeedArgs`,
  etc.) via `model.model_json_schema()`.

The descriptor list is rendered into the system prompt as a JSON block
labeled `# AVAILABLE TOOLS`. The discriminated-union schema in Decision 1
references the descriptors so the LLM can only emit a `tool_name`
present in this turn's catalog.

**Rationale**:

- Honors the edge-case requirement "tool catalog drift — surface the
  up-to-date catalog on every call". Because we read `TOOL_REGISTRY` per
  request, adding or removing a tool propagates automatically without a
  redeploy of the prompt.
- Reuses Pydantic argument models that are already covered by tests for
  feature 001 — no schema drift risk.
- Matches FR-009 verbatim ("name, parameter shape, short description").

**Alternatives considered**:

- *Hand-written prompt that lists tool names*: rejected — duplicates the
  registry and bit-rots silently.
- *Embedding the tools as MAF `AIFunction` objects*: rejected — that is
  precisely the path FR-003 forbids because it pulls in the agent loop.

---

## 3. Chat history sourcing & trimming

**Decision**: Two mutually exclusive history sources, tried in this
order:

1. If the request carries an `X-Session-ID` header AND a non-empty
   session is found in the in-memory `SessionStore` (feature 003), use
   `store.recent_view(session, token_budget=settings.momdiary_session_prompt_token_budget)`
   as the history. Append the caregiver's new message and the
   assistant's response to the session at the end of the request.
2. Otherwise, use `request.history` (a list of `{role, text}` items in
   the request body) as-is, then trim it from the **oldest** turn first
   until the estimated token count fits the budget.

In both cases, the dispatcher does NOT mix sources within one request
(FR-008's intent: the client either drives history itself or delegates
to the server).

**Rationale**:

- Reuses the bounded, already-tested session store (FR-009 / FR-010 /
  FR-011 / FR-012 / FR-013 from feature 003) without forking it.
- Matches the spec's assumption that "chat history is supplied by the
  client on each request (consistent with feature 002's frontend chat
  pattern) **or** pulled from the in-process session store added in
  feature 003 when a session id is supplied".
- Trim-oldest-first satisfies the edge case "Conversation history
  exceeds the model's context window" without rejecting requests that
  are merely long.

**Alternatives considered**:

- *Persist history in SQLite under this feature*: rejected — the spec
  explicitly excludes "Multi-process or persistent session storage".
- *Always require client-supplied history*: rejected — would force the
  frontend to re-implement the bounded retention rules feature 003
  already enforces.

---

## 4. Microsoft Agent Framework First (Principle V) reconciliation

**Decision**: Build the dispatcher on
`agent_framework.azure.AzureOpenAIChatClient` (an MAF primitive) and
explicitly NOT on `agent_framework.ChatAgent`. Record the scope-narrowing
in the plan's Complexity Tracking section. Continue to suppress the
documented MAF prerelease warnings via the existing
`AGENT_FRAMEWORK_WARNINGS.md` policy.

**Rationale**:

- Principle V mandates *the Microsoft Agent Framework* — it does not
  mandate any specific class within it. `AzureOpenAIChatClient` is a
  framework primitive; using it keeps MomDiary on the approved stack.
- FR-003 directly forbids `Agent` / `ChatAgent` for this endpoint;
  resolving the conflict in favor of "use MAF, just at a lower layer"
  honors both rules. This is the same resolution feature 004's plan
  recorded.
- Continuing to pin the December-2025 beta line
  (`agent-framework-core==1.0.0b251211`,
  `agent-framework-azure-ai==1.0.0b251211`) honors the "track the latest
  prerelease cadence" obligation.

**Alternatives considered**:

- *Call Azure OpenAI via `openai` SDK directly*: rejected — that
  introduces a non-MAF dependency for AI work, which Principle V
  prohibits.
- *Build a degenerate `ChatAgent` with empty tools and inspect its raw
  message*: rejected — it pulls in the agent loop FR-003 forbids and
  obscures the one-shot nature of the call.

---

## 5. Determinism strategy for tests

**Decision**: Define a tiny `ChatClientProtocol` in
`services/chatentry_dispatcher.py` with one method —
`async def get_response(self, *, messages, response_format) -> ChatResponse`
— and inject it via a FastAPI dependency. Tests provide a
`FakeChatClient` that:

- inspects the assembled prompt (asserts the live tool catalog and
  trimmed history are both present);
- returns a hand-crafted JSON payload that matches the
  `LLMDecision` schema for the scenario under test
  (`tool_call` for happy paths, `clarification` for US3, malformed for
  the malformed-output edge case, raises an exception for the
  timeout edge case).

**Rationale**:

- Principle II forbids live-model calls in CI; injection is the standard
  pattern.
- Keeping the protocol minimal (one method) means the fake stays trivial
  and contract tests do not couple to MAF internals.

**Alternatives considered**:

- *Record-and-replay against a real Azure deployment*: rejected — adds
  flake and credentials to CI.
- *Mock at the network layer (`respx`)*: rejected — couples tests to
  the wire format of the prerelease MAF client and breaks on every
  bump.

---

## 6. Failure-mode taxonomy

**Decision**: Map every failure to exactly one of the five outcome
values, with logging keyed by `correlation_id`:

| Failure                                                             | Outcome                  | DB writes? | Notes                                                                                              |
| ------------------------------------------------------------------- | ------------------------ | :--------: | -------------------------------------------------------------------------------------------------- |
| LLM returns valid `tool_call` and the tool succeeds                 | `created` / `updated` / `deleted` |     yes    | Inherited from existing repository (idempotent, soft-delete).                                      |
| LLM returns `clarification`                                         | `clarification_requested` |     no     | `agent_message` carries the question; `suggested_candidates` optional.                             |
| LLM returns malformed JSON or violates the `LLMDecision` schema     | `error` (`malformed_llm_output`) |     no     | Logged with model-id, latency, and raw output prefix. Edge case "LLM returns malformed output".    |
| LLM names a tool not in `TOOL_REGISTRY` (schema-violating)          | `error` (`unknown_tool`) |     no     | Treated as malformed (FR-005). Tool catalog drift handled by Decision 2.                            |
| Tool argument validation fails (Pydantic)                           | `error` (`invalid_tool_arguments`) |     no     | Edge case "parameters fail tool's input validation".                                                |
| Tool raises (DB constraint, time-zone error, etc.)                  | `error` (`tool_execution_failed`) | depends on tool's transaction | Tool layer handles its own rollback (existing repo behavior).                                  |
| LLM call times out / transport error                                | `error` (`llm_unavailable`) |     no     | No destructive retries (FR-013).                                                                   |
| Caregiver message exceeds size cap                                  | `error` (HTTP 400, `validation_error`) |     no     | FR-014.                                                                                            |
| History exceeds prompt budget                                       | trim oldest first; never reject solely on length unless the current message alone exceeds the cap | depends on outcome | FR-014 + edge case.                                                                                |

**Rationale**: Aligns 1:1 with the five `outcome` values exposed in the
OpenAPI fragment (Phase 1) and lets contract tests assert behavior per
row.

**Alternatives considered**:

- *Surface every error as HTTP 500*: rejected — caregivers need a
  human-readable `agent_message` even on failure, and clarifications
  are not errors.
- *Collapse `error` reasons into a single string*: rejected — operators
  need the typed reason to triage drift quickly (FR-010).

---

## Open questions resolved

| Question                                                                                | Resolution                                                                  |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Does the endpoint share the diary agent's system prompt?                                | No. This endpoint owns its own one-shot prompt (Decision 1).                |
| Does the endpoint write to `agent_interactions` (the diary audit table)?                | No. This is a separate dispatch path; logging stays in `structlog`. The diary table is unchanged. |
| Does the endpoint emit `X-Session-ID` on the response, mirroring `/v1/entries`?         | Yes — re-uses the same header so the frontend pattern is unchanged.         |
| Is the new endpoint added to the existing OpenAPI document?                             | Yes (FR-015), via a contract fragment under `contracts/`.                   |

No `[NEEDS CLARIFICATION]` items remain.
