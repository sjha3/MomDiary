# MomDiary

A baby-tracker journal with a natural-language chat interface. Caregivers can log
feeds, sleeps, diapers (poops), and appointments either through the typed UI or
by chatting with an LLM agent that converts free-text into structured entries.

- **Backend**: Python 3.12 · FastAPI · SQLAlchemy 2 (async) + SQLite ·
  Microsoft Agent Framework (`agent-framework` 1.0.0rc6) · Azure OpenAI via
  Microsoft Entra ID (`DefaultAzureCredential`).
- **Frontend**: React 18 · TypeScript 5 · Vite 5 · TanStack Query v5 ·
  Tailwind CSS 3 · zod (response validation) · date-fns / date-fns-tz.

---

## Repository layout

```text
backend/    FastAPI app, agents, repositories, Alembic migrations, tests
frontend/   React + Vite SPA
specs/      Feature specifications (spec-kit)
```

---

## Running the backend

Prerequisites: Python 3.12, `uv` or `pip`, and an Azure OpenAI deployment you
can reach via `DefaultAzureCredential` (run `az login` locally).

```powershell
cd backend

# 1. create + activate a virtualenv
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. install (editable, with dev extras)
pip install -e ".[dev]"

# 3. configure environment
Copy-Item .env.example .env   # edit AZURE_OPENAI_* to match your deployment

# 4. apply database migrations
alembic upgrade head

# 5. sign in to Azure (one time per shell)
az login

# 6. run the API
uvicorn momdiary.main:app --reload --port 8000
```

The API is now at `http://localhost:8000` with OpenAPI docs at
`http://localhost:8000/docs`.

### Backend tests

```powershell
cd backend
$env:PYTHONPATH = "src"
pytest -q
```

### Key environment variables

| Variable | Purpose |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI / API Management endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | Model deployment name (e.g. `gpt-4.1`) |
| `AZURE_OPENAI_API_VERSION` | Azure OpenAI API version |
| `MOMDIARY_DB_URL` | SQLAlchemy URL (default `sqlite+aiosqlite:///./momdiary.db`) |
| `MOMDIARY_DEFAULT_TIMEZONE` | IANA TZ used for date-window queries |
| `MOMDIARY_ALLOWED_ORIGINS` | Comma-separated CORS allow-list |
| `MOMDIARY_SESSION_*` | Chat session-store limits (TTL, turns, bytes, token budget) |

---

## Running the frontend

Prerequisites: Node.js 20+.

```powershell
cd frontend

# 1. install
npm install

# 2. configure backend URL
Copy-Item .env.example .env   # default VITE_API_BASE_URL=http://localhost:8000

# 3. run dev server
npm run dev      # http://localhost:5173

# production build / preview
npm run build
npm run preview
```

The dev server proxies API calls to `VITE_API_BASE_URL`. Make sure that origin
is included in the backend's `MOMDIARY_ALLOWED_ORIGINS`.

---

## The `/v1/entries` API

`POST` and `PUT /v1/entries` are the chat-driven write endpoints. They accept a
natural-language `message`, route it through the diary agent (which may invoke
a structured tool like `log_feed` / `log_poop` / `log_appointment`), and return
either a created/updated/deleted entry or a clarification question.

Read endpoints (`/v1/feeds`, `/v1/sleeps`, `/v1/poops`, `/v1/appointments`)
return entries for a given local date and are not chat-driven.

### Request

```http
POST /v1/entries
Content-Type: application/json
X-Session-ID: <optional, returned by previous response>

{
  "message": "fed 4oz formula at 7:30am",
  "entry_id": null,
  "entry_type": null,
  "correlation_id": null
}
```

- `message` *(required, 1–2000 chars)* — caregiver's free-text input.
- `entry_id` + `entry_type` *(optional)* — when both are present the request is
  treated as a **deterministic update/delete** for an existing row and skips
  the LLM tool-selection step.
- `correlation_id` *(optional)* — propagated through logs; generated if absent.
- `X-Session-ID` header *(optional)* — opaque session token that threads chat
  history across turns. If omitted the server creates a new session and echoes
  the ID back in the response header and body.

`PUT /v1/entries` uses the same payload but requires `entry_id` + `entry_type`
to identify the row to mutate.

### Response — created / updated / deleted (HTTP 200/201)

```json
{
  "outcome": "created",
  "entry_type": "feed",
  "entry": {
    "id": 42,
    "entry_type": "feed",
    "feed_type": "formula",
    "quantity": 120,
    "unit": "ml",
    "occurred_at": "2026-05-19T07:30:00-07:00",
    "created_at": "...",
    "updated_at": "..."
  },
  "agent_message": "Logged a 120 ml formula feed at 7:30 AM.",
  "correlation_id": "…",
  "session_id": "…"
}
```

The discriminator inside `entry` (`entry_type`) selects one of:

- **feed** — `feed_type` ∈ `breast_milk | formula | solids | water`,
  `quantity > 0`, `unit` ∈ `ml | g`.
- **sleep** — `start_at`, `end_at`, derived `duration_minutes`.
- **poop** — `occurred_at`, `consistency` ∈ `watery | soft | formed | hard`
  (caregiver phrases like *normal / regular / typical* map to `soft`; when
  consistency is not mentioned the agent defaults to `soft`).
- **appointment** — `scheduled_at` + appended `notes[]`.

### Response — clarification requested (HTTP 200)

When the agent cannot confidently pick a tool or is missing a required field:

```json
{
  "outcome": "clarification_requested",
  "agent_message": "What time was the feed?",
  "suggested_candidates": null,
  "correlation_id": "…",
  "session_id": "…"
}
```

### Response — error (HTTP 400 / 422 / 503)

```json
{
  "error": "validation_error",
  "message": "message must be 1..2000 chars",
  "details": null,
  "correlation_id": "…",
  "session_id": "…"
}
```

### Session header

Every `/v1/entries` response sets `X-Session-ID`. The client must echo it back
on the next request to keep the LLM's short-term chat history coherent. The
session store is in-memory and bounded by `MOMDIARY_SESSION_*` settings.

### Alternate one-shot endpoint: `/v1/chatentry/`

`POST /v1/chatentry/` is a thinner sibling of `/v1/entries` introduced by
[feature 005](specs/005-direct-llm-chatentry/quickstart.md). It bypasses the
Microsoft Agent Framework runner and instead asks the chat client directly,
in a single turn, to emit a structured-output JSON decision (`tool_call` or
`ask_for_clarification`) which the backend then dispatches against the same
tool registry used by `/v1/entries`. Use it when you want a leaner request
path without the agent loop. The existing `/v1/entries` endpoint is
**unchanged** and remains the default chat write path; both endpoints share
the same database, tool implementations, and session-store semantics.

---

## Frontend integration

The chat box (`frontend/src/features/chat/ChatPanel.tsx`) calls `/v1/entries`
through a small typed client:

1. The user types a message and submits.
2. `postEntries({ message })` (in `frontend/src/features/chat/api.ts`) sends a
   `POST /v1/entries`, attaching the most recent `X-Session-ID` if known.
3. The response is parsed against the zod schemas in
   `frontend/src/shared/types.ts`. Strict parsing means any backend drift
   (e.g. an unknown `consistency` value) surfaces immediately.
4. On a `created | updated | deleted` outcome the matching list query is
   invalidated via TanStack Query, so the relevant section (Feeds, Sleeps,
   Poops, Appointments) re-fetches and re-renders.
5. On `clarification_requested`, the `agent_message` is appended to the chat
   transcript and no list is invalidated.
6. The new `X-Session-ID` is stored in component state for the next turn.

The list sections call the read endpoints (`/v1/feeds`, `/v1/sleeps`, etc.)
for the currently selected date in the date bar; they are independent from the
chat flow except for the cache-invalidation step above.

UI details:

- The chat panel pops up from a floating bubble at the bottom-right; the
  hide/show preference is persisted in `localStorage` under
  `momdiary.chatVisible`.
- Each entry section becomes scrollable (`max-h-72`) once it has more than 5
  items.
- Appointment items collapse multi-note threads behind a `+N more` toggle.

---

## Further reading

- [`backend/src/momdiary/agents/README.md`](backend/src/momdiary/agents/README.md) —
  agent / tool / dispatcher architecture, including the `/chatentries` bypass.
- [`specs/`](specs/) — feature specs, plans, and tasks generated via spec-kit.
