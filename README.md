# Lyftr Chat: LLM chatbot with key failover and response caching

A full-stack chat app. The **React** frontend talks to a **FastAPI** backend. The backend calls LLMs through **LiteLLM** using a pool of API keys, fails over automatically when a key returns 429, a quota error or a 5xx, caches identical prompts with LiteLLM's built-in cache and stores every conversation in **SQLite**.

```
/backend             FastAPI + LiteLLM + SQLite (tests in backend/tests)
/frontend            React (Vite) single-page app, served by nginx in Docker
docker-compose.yml   both services + a named volume mounted at /data
Makefile             make up / make down (+ logs, test, clean)
.env.example         every configuration variable, with placeholders
render.yaml          Render blueprint for the live deployment
```

---

## 1. Live URLs

| Tier | URL |
|------|-----|
| Frontend | https://lyftr-chat-web.onrender.com |
| Backend API base | https://lyftr-chat-api-ycbd.onrender.com |
| Health | https://lyftr-chat-api-ycbd.onrender.com/health |
| Interactive API docs | https://lyftr-chat-api-ycbd.onrender.com/docs |

> Both services run on Render's free tier, so the first request after a period of inactivity can take about 30–60 s while the backend wakes up (the UI shows a "Connecting to the server" notice until it is reachable).
>
> **Live configuration:** two keys in the pool. `key_1` uses `gemini/gemini-3.5-flash-lite` and `key_2` uses `gemini/gemini-flash-lite-latest` (`LLM_KEY_MODELS`), so a capacity problem on one model does not take down both keys. `ENABLE_FAILURE_SIMULATION=true`. The free tier has no persistent disk, so the deployed SQLite file at `/data/app.db` is reset whenever the service is redeployed or restarted. Locally, the Docker named volume keeps it across restarts.

---

## 2. Run locally

### With Docker (recommended)

```bash
cp .env.example .env      # put two real keys into LLM_API_KEYS
make up                   # backend → http://localhost:8000, frontend → http://localhost:3000
make down                 # stop (the SQLite volume is kept)
```

Without a `.env`, the stack still starts using two **demo keys** (`mock-…`). Those return offline echo replies through LiteLLM's mock mode, so failover, caching, history and token counting can be tried without spending provider quota.

Other targets: `make logs`, `make test`, `make clean` (also deletes the SQLite volume).

### Without Docker

Backend (Python 3.11+):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export LLM_API_KEYS="key-one,key-two" DATABASE_URL="sqlite:///./app.db" ENABLE_FAILURE_SIMULATION=true
uvicorn app.main:app --reload --port 8000
pytest                    # 32 offline tests
```

Frontend (Node 18+):

```bash
cd frontend
npm install
VITE_API_URL=http://localhost:8000 npm run dev    # http://localhost:3000
```

### Configuration

| Variable | Meaning | Default |
|---|---|---|
| `LLM_API_KEYS` | Comma-separated key pool (≥ 2). Ids are `key_1`, `key_2`, … in this order | — |
| `LLM_MODEL` | LiteLLM model used by every key | `gemini/gemini-3.5-flash-lite` |
| `LLM_KEY_MODELS` | Optional per-key models, same order as the keys (e.g. a second provider for `key_2`) | — |
| `DATABASE_URL` | SQLite location | `sqlite:////data/app.db` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | `http://localhost:3000` |
| `ENABLE_FAILURE_SIMULATION` | `true` enables the `X-Simulate-Failure` header | `false` |
| `DEFAULT_SYSTEM_PROMPT` | System prompt used when the client sends none | built-in |
| `CACHE_TTL_SECONDS` | Lifetime of a cached response | `3600` |
| `KEY_COOLDOWN_SECONDS` | How long a key that hit a real 429/quota error is moved to the back of the pool | `30` |
| `LLM_TIMEOUT_SECONDS` | Per-attempt provider timeout | `30` |
| `LLM_MAX_OUTPUT_TOKENS`, `LLM_TEMPERATURE` | Generation settings | `1024`, `0.2` |
| `MAX_HISTORY_MESSAGES` | How many stored messages are replayed to the model | `40` |
| `VITE_API_URL` (frontend) | Backend base URL the browser calls | `http://localhost:8000` |

---

## 3. Design decisions

### Request flow

```
POST /chat
  ├─ validate body (422)          session_id 1–128 chars, message 1–4000 chars after trim
  ├─ parse X-Simulate-Failure     only when ENABLE_FAILURE_SIMULATION=true
  ├─ build messages               system prompt + SQLite history + new user message
  ├─ for key in pool (key_1, key_2, …):
  │     litellm.completion(model, messages, api_key=key, caching=True, num_retries=0)
  │       ├─ cache hit  → LLM_CACHE, key_id=null, fallback_attempts=0
  │       ├─ success    → LIVE_INFERENCE, key_id=key_n, fallback_attempts=n-1
  │       └─ 429 / quota / 5xx / timeout → record, try next key
  ├─ every key failed → 503 {"detail": "all providers unavailable"}  (nothing stored)
  └─ success → store user + assistant rows in one SQLite transaction → 200
```

### Key fallback

* **Explicit, ordered failover over LiteLLM calls.** Each attempt is a single `litellm.completion` call with `num_retries=0` and its own `api_key`, so a failing key is dropped immediately instead of being retried. LiteLLM normalises every provider error into typed exceptions (`RateLimitError`, `ServiceUnavailableError`, `InternalServerError`, `Timeout`, …), which keeps the failover loop provider-agnostic. I chose a small explicit loop over LiteLLM's `Router` because the contract requires exact reporting of *which* key answered (`key_id`) and *how many* failed first (`fallback_attempts`), plus per-key failure injection for one request only. A plain loop makes all three deterministic and easy to test.
* **Any provider error triggers failover**, not just 429/5xx. A revoked key (401) or a timeout should never reach the user either. Only when the whole pool fails does the API return `503 {"detail": "all providers unavailable"}`.
* **Cooldown for real rate limits.** A key that hits a *real* 429 or quota error is moved to the back of the pool for `KEY_COOLDOWN_SECONDS`, so later requests don't keep paying the latency of a key that is known to be exhausted. Keys in cooldown are still tried last, so a cooldown can never cause an outage on its own. Simulated failures never trigger a cooldown, so they really do affect only one request.
* **Failure simulation** (`X-Simulate-Failure: key_1=429,key_2=500`, `*=503`) raises the same LiteLLM exception types a provider would, inside the same loop. The real failover code path is exercised. A malformed header returns 422.
* **Secrets never leave the server.** Responses and logs only ever contain `key_1`, `key_2`, … Logged errors include the key id, status and exception type, never the key or the raw provider message.

### Caching

* **LiteLLM's built-in in-memory cache** (`litellm.cache = Cache(type="local", ttl=…)`, `caching=True` per call). The cache key is derived from the model plus the **full message list** (system prompt + history + new message) and the generation parameters. So:
  * the same first message in a new session returns `LLM_CACHE` the second time;
  * a different message, or the same message later in a conversation, is never served from cache;
  * the API key is not part of the cache key, so a response produced by `key_2` can be reused when `key_1` is first in line.
* Hits are detected from LiteLLM's `response._hidden_params["cache_hit"]`. On a hit the reply text is identical, the token counts are those stored with the original response, `key_id` is `null`, `fallback_attempts` is `0`, and latency is a few milliseconds instead of hundreds.
* When `X-Simulate-Failure` is present, the cache lookup is bypassed for that request. Otherwise a warm cache would hide the failure being demonstrated.
* In-memory was chosen over Redis because the brief forbids external services, and it is the fastest option. The trade-off is that the cache is per-process and empties on restart, which is acceptable for a cache. LiteLLM's disk cache could be enabled the same way if persistence across restarts mattered.

### SQLite session storage

* Two tables: `messages` (the required schema, plus an index on `(session_id, id)`) and `sessions` (`session_id`, the session's custom `system_prompt`, timestamps). The schema is created automatically on startup with `CREATE TABLE IF NOT EXISTS`.
* **Only successful turns are written.** The user message and the assistant reply (with its metadata as JSON) are inserted together in one `BEGIN IMMEDIATE` transaction *after* the LLM call succeeds, so a 422 or 503 never leaves a half-written turn or an orphan session.
* The client only sends the new message. The server rebuilds the context from SQLite on every request, keeping the last `MAX_HISTORY_MESSAGES` messages to bound prompt size.
* WAL journal mode, a short connection per operation and a process-level write lock keep concurrent requests safe.
* `GET /sessions/{id}/messages` returns history oldest-first, without the system prompt. Assistant rows include their `metadata`. Unknown ids return `404 {"detail": "session not found"}`.
* In Docker the file lives at `/data/app.db` on the named volume `chat-data`, so history survives `docker compose restart` and `make down && make up`.

### Errors and validation

* Every error is JSON with a `detail` field. Validation errors (missing/empty fields, message over 4000 characters after trimming, session id over 128 characters, wrong types, malformed JSON) return 422. A catch-all handler turns any unexpected exception into `500 {"detail": "internal server error"}`, so no stack trace or HTML page is ever returned.

### Frontend

* A new session id (`s-xxxxxxxxxxxx`) is generated on every page load. **New chat** starts another one without reloading.
* Deliberately minimal chat layout: a header with **New chat** and a settings button, the conversation, and the message box.
* Under every assistant reply there is a quiet metadata line: `resolution_source`, `model`, latency and input/output tokens of that request. When a reply needed failover, it also says which key served it and after how many failures. All contract `data-testid`s are present, and each one holds exactly the raw value (e.g. `LIVE_INFERENCE`, `812 ms`, `42`).
* The settings dialog holds the optional **Instructions** (system prompt, `data-testid="system-prompt-input"`) and a **Simulate key failure** selector, which sends `X-Simulate-Failure` for demos. A "Failure test on" badge stays visible while it is active.
* Errors (422, 503, network) appear as a readable message in the chat with a **Try again** button, never as a blank screen.
* The API URL is set at build time (`VITE_API_URL`). The Docker image can also override it at container start through `API_URL`, which is written to `/config.js`, so no rebuild is needed.

### Docker

* **Backend:** two stages. Dependencies are installed into a virtualenv in a builder stage, and only that venv plus the app code are copied into a fresh `python:3.12-slim`. The app runs as a non-root user and has a healthcheck.
* **Frontend:** two stages. `node:20-alpine` builds the bundle, and only the static files are copied into `nginx:alpine` (about 75 MB) listening on port 3000.
* All configuration comes from environment variables.

---

## 4. Verification

Set a base URL first (live or local):

```bash
API=https://lyftr-chat-api-ycbd.onrender.com     # or http://localhost:8000
```

**Health**

```bash
curl -s $API/health
# {"status":"ok","keys_configured":2,"cache_enabled":true, ...}
```

**Live inference, then a cache hit.** Same first message in two new sessions:

```bash
curl -s -X POST $API/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"s-demo-1","message":"What is the capital of France?"}'
# "resolution_source":"LIVE_INFERENCE", "key_id":"key_1", "latency_ms": 700+

curl -s -X POST $API/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"s-demo-2","message":"What is the capital of France?"}'
# "resolution_source":"LLM_CACHE", "key_id":null, identical reply and tokens, latency_ms in single digits
```

**Failover**

```bash
curl -s -X POST $API/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: key_1=429' \
  -d '{"session_id":"s-demo-3","message":"Name three primary colours."}'
# 200, "key_id":"key_2", "fallback_attempts":1

curl -s -X POST $API/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: key_1=500' \
  -d '{"session_id":"s-demo-3","message":"And three secondary ones?"}'
# 200, "key_id":"key_2"

curl -s -i -X POST $API/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: *=429' \
  -d '{"session_id":"s-demo-4","message":"hello"}'
# HTTP 503 {"detail":"all providers unavailable"}

curl -s -i $API/sessions/s-demo-4/messages
# HTTP 404: the failed request was not stored
```

**Multi-turn memory and per-message tokens**

```bash
curl -s -X POST $API/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"s-demo-5","message":"My name is Ada."}'
curl -s -X POST $API/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"s-demo-5","message":"What is my name?"}'
curl -s $API/sessions/s-demo-5/messages
```

`input_tokens` grows on the second turn because the history is part of that request's prompt. It is still the count for *that request only*, never a running total. `output_tokens` is the size of that reply only.

**Validation**

```bash
curl -s -i -X POST $API/chat -H 'Content-Type: application/json' -d '{"session_id":"s-x","message":"   "}'   # 422
curl -s -i -X POST $API/chat -H 'Content-Type: application/json' -d '{oops'                               # 422
```

**In the UI:**

1. Send *"What is the capital of France?"*. The line under the reply reads `LIVE_INFERENCE · <model> · ~900 ms · 32 in · 7 out`.
2. Click **New chat** and send the same question. The reply is identical and the line reads `LLM_CACHE · … · 3 ms` with the same token counts.
3. Ask a follow-up such as *"What river runs through it?"*. The answer uses the earlier context, and `in` grows because the history is part of this request's prompt.
4. Open the settings button (top right) → **Simulate key failure** → *key_1 returns 429* → **Done**, then send a message. The reply shows *served by key_2 after 1 failover*.
5. Choose *Every key returns 429* and send a message. A readable "All providers unavailable" error appears in the chat, and `GET /sessions/<id>/messages` shows that the failed turn was not stored.

**Automated tests** (offline, using demo keys):

```bash
make test        # or: cd backend && pytest
```

They cover the contract shape, cache hit/miss and identical replies, per-request tokens, multi-turn history and session isolation, 404/422/503 behaviour, every simulated status, the "nothing stored on failure" rule, a real (non-simulated) provider failure falling back to `key_2`, and CORS.

---

## 5. Setup Used

* **Editor:** Visual Studio Code
* **Languages / runtimes:** Python 3.12, Node.js 20
* **Libraries:** FastAPI, LiteLLM, Pydantic, Uvicorn, React 18, Vite
* **Tooling:** Docker / Docker Compose, GNU Make, pytest, Playwright (UI smoke check), curl
* **Hosting:** Render (Docker web service for the API, static site for the frontend)

---

## 6. Bonus features

* **Session system prompt.** An optional field (`data-testid="system-prompt-input"`) and `system_prompt` in the API. It is stored per session, so later turns keep using it.
* **Failover test switch in the UI.** The settings dialog sends `X-Simulate-Failure` presets, so failover can be shown without curl.
* **Key cooldown** after real 429/quota errors, which saves latency on keys that are known to be exhausted.
* **Different model per key** (`LLM_KEY_MODELS`). `key_2` can use another model or even another provider, so an overloaded model or a provider-wide outage is survivable. The live deployment uses two different Gemini models.
* **Demo keys** (`mock-…`) run the whole stack offline through LiteLLM's mock mode. They are useful for tests and for trying the app without provider quota.
* **Richer `/health`.** Database status, simulation flag and per-key cooldown state, still with the required `status`, `keys_configured` and `cache_enabled` fields.
* **UI niceties.** New chat button, Try again on errors, copy button on replies, Markdown rendering (lists, bold, code), auto-growing input, wake-up notice for the free-tier backend, automatic dark mode and a mobile layout.
* **Runtime-configurable frontend image** (`API_URL` → `/config.js`).
