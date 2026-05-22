# Quickstart — Direct-LLM Chat Entry Endpoint

**Feature**: `005-direct-llm-chatentry`
**Audience**: backend developers wiring or exercising the new endpoint.

This quickstart references the [MomDiary Constitution](../../.specify/memory/constitution.md)
(Principles I–V) — particularly Principle V's "Microsoft Agent Framework
First" rule, which is preserved by building this endpoint on the MAF
`AzureOpenAIChatClient` primitive while deliberately not using
`Agent` / `ChatAgent` (see `plan.md` Complexity Tracking).

---

## 1. Prerequisites

- Python 3.12 environment with the backend installed in editable mode:

  ```powershell
  cd "d:\Azure AI\MomDiary\backend"
  pip install -e ".[dev]"
  ```

- Azure OpenAI / Foundry deployment reachable via Microsoft Entra ID
  (`DefaultAzureCredential`). Required environment variables (already
  used by features 001 and 003):

  ```dotenv
  AZURE_OPENAI_ENDPOINT=https://<your-foundry>.openai.azure.com/
  AZURE_OPENAI_DEPLOYMENT=gpt-4.1
  AZURE_OPENAI_API_VERSION=2024-10-21
  ```

- Existing SQLite file at `backend/momdiary.db` (Alembic-managed by
  feature 001). Nothing in this feature alters the schema.

---

## 2. Run the backend

```powershell
cd "d:\Azure AI\MomDiary\backend"
$env:PYTHONPATH = "src"
uvicorn momdiary.main:app --reload --port 8000
```

The new router registers itself in `momdiary.main.create_app()` so the
endpoint is available at `POST http://localhost:8000/v1/chatentry/`.

---

## 3. Smoke-test with `curl` / `Invoke-RestMethod`

### 3.1 Create a feed (User Story 1)

```powershell
$body = @{
  message = "120 ml breast milk just now"
  history = @()
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://localhost:8000/v1/chatentry/ `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Expected response shape:

```jsonc
{
  "outcome": "created",
  "agent_message": "Logged 120 ml breast milk feed.",
  "entry_type": "feed",
  "entry_id": 42,
  "selected_tool": "log_feed",
  "correlation_id": "…",
  "session_id": "…"
}
```

The response also carries `X-Session-ID` and `X-Correlation-ID` headers,
matching `/v1/entries`.

### 3.2 Correct the prior feed by reference (User Story 2)

Re-send the request with the previous response's session id in the
header — the server-side session store supplies the prior turn so the
LLM can resolve "make it 90":

```powershell
$body = @{ message = "actually make it 90" } | ConvertTo-Json
Invoke-RestMethod `
  -Uri http://localhost:8000/v1/chatentry/ `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ "X-Session-ID" = "<previous-session-id>" } `
  -Body $body
```

Expected response:

```jsonc
{
  "outcome": "updated",
  "agent_message": "Updated feed to 90 ml.",
  "entry_type": "feed",
  "entry_id": 42,        // SAME id as the previous turn — no duplicate row
  "selected_tool": "update_feed",
  "correlation_id": "…",
  "session_id": "<previous-session-id>"
}
```

### 3.3 Ambiguous input → clarification (User Story 3)

```powershell
$body = @{ message = "delete that"; history = @() } | ConvertTo-Json
Invoke-RestMethod `
  -Uri http://localhost:8000/v1/chatentry/ `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Expected response:

```jsonc
{
  "outcome": "clarification_requested",
  "agent_message": "Which entry should I delete?",
  "selected_tool": null,
  "correlation_id": "…",
  "session_id": "…"
}
```

The DB is unchanged.

---

## 4. Run the test suite

The feature ships with contract, unit, and integration tests; all of
them inject a deterministic `FakeChatClient` so no live model is called
in CI (Principle II).

```powershell
cd "d:\Azure AI\MomDiary\backend"
$env:PYTHONPATH = "src"
pytest -q tests/contract/test_chatentry_contract.py `
        tests/unit/test_chatentry_dispatcher.py `
        tests/unit/test_chatentry_catalog.py `
        tests/unit/test_chatentry_prompt.py `
        tests/integration/test_chatentry_create_paths.py `
        tests/integration/test_chatentry_correction.py `
        tests/integration/test_chatentry_clarification.py `
        tests/integration/test_chatentry_malformed_llm.py `
        tests/integration/test_chatentry_session_reuse.py
```

The optional benchmark for handler-side latency (≤ 100 ms p95) lives
behind the same `--run-benchmarks` opt-in flag the project already uses.

---

## 5. Operational notes

- **Logging**: every LLM call and every tool dispatch emits a structured
  `structlog` record with `correlation_id`, `session_id`, model name,
  latency, and outcome (FR-010 + Principle V's observability rule).
- **Tool catalog drift**: adding a new tool to `TOOL_REGISTRY` makes it
  available to the LLM on the next request — no prompt redeploy
  required (research.md §2). Removing a tool removes it from the LLM's
  enum, so a stale request can never name it.
- **No persistent session storage**: the in-memory session store from
  feature 003 is reused as-is; restarting the process clears history.
  This matches the spec's out-of-scope list.
- **Prerelease pinning**: this feature consumes
  `agent-framework-core==1.0.0b251211` and
  `agent-framework-azure-ai==1.0.0b251211`, recorded in
  `backend/pyproject.toml`. Warning suppressions remain governed by
  `backend/docs/AGENT_FRAMEWORK_WARNINGS.md`.

---

## 6. Where to find each piece of code

| Concern                                | File                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| HTTP router (POST /v1/chatentry/)      | `backend/src/momdiary/api/chatentry.py`                 |
| Dispatcher + ChatClientProtocol        | `backend/src/momdiary/services/chatentry_dispatcher.py` |
| Tool catalog projection                | `backend/src/momdiary/services/chatentry_catalog.py`    |
| Pydantic request / response / decision | `backend/src/momdiary/models/schemas.py`                |
| Tool registry (reused, unchanged)      | `backend/src/momdiary/agents/tools/registry.py`         |
| Session store (reused, unchanged)      | `backend/src/momdiary/agents/session_store.py`          |
| OpenAPI contract                       | `specs/005-direct-llm-chatentry/contracts/chatentry.openapi.yaml` |
