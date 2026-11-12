# free-pi gateway

Local gateway in front of `api.freepi.ai` that exposes:

- `POST /v1/chat/completions` — OpenAI-compatible (streaming + non-streaming)
- `POST /v1/messages` — Anthropic Messages API (for Claude Code), fully translated
- `POST /v1/messages/count_tokens`
- `GET /v1/models` — real model catalog
- `GET /admin` — admin UI (accounts + usage)
- `GET /health`

Every upstream request carries the free-pi-cli fingerprint:
`Authorization: Bearer <jwt>`, `x-session-id`, `x-client-version`.

## Client version (`x-client-version`)

Upstream gates on the fingerprint's version and refuses a stale one before it
even looks at the request:

```text
426 {"code":"upgrade_required","message":"your free-pi-cli is below the required minimum (0.6.19); update with: npx free-pi-cli@latest","error":{"type":"free_pi_error"}}
```

so the gateway does not hard-code it. Every `versionCheckMs` (10 min), and
always on start — a restart re-reads it instead of trusting a cached value,
retrying a flaky fetch — it calls the unauthenticated `GET /client-version`
(the CLI's own update check), which publishes the details:

```json
{ "min": "0.6.19", "latest": "0.6.19", "min_desktop_version": "0.0.0", "latest_desktop_version": "0.3.4", "models": [ ... ] }
```

The value sent is `latest` — the release the CLI itself would install. `min` is
only a floor (used when `latest` is absent), and the locally installed CLI
(`~/.free-pi/agent/last-seen-version`, then the npx cache) is only a fallback
for when the fetch fails. It only moves up, so a later refresh never undoes a
bump. A `426 upgrade_required` on any request is not passed to the client: the
minimum is read out of the message, adopted, and the request is retried
immediately (up to twice).

`GET /health` reports the resolved value plus the upstream detail:

```json
"clientVersion": { "version": "0.6.19", "source": "client-version", "min": "0.6.19", "latest": "0.6.19", "detail": { ... } }
```

## Run

```bash
node index.js              # reads shi.json in this directory
```

Claude Code:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=x claude
```

OpenAI clients:

```text
Base URL: http://127.0.0.1:8787/v1
API key:  anything (or a key from clientKeys in shi.json)
```

## Multiple accounts

Each account is one free-pi JWT. Sources, in priority order:

1. **`.env` or the process environment** (read-only in the UI):
   - `FREEPI_ACCOUNTS=token1,token2` or `FREEPI_ACCOUNTS=["tok1","tok2"]`
   - or `FREEPI_TOKEN_1=...`, `FREEPI_TOKEN_2=...` (up to 20)
   - both are read: the real environment wins over the file, so
     `docker run -e FREEPI_TOKEN_1=...` works without a `.env`
2. **Admin UI** — two ways:
   - **Sign in with GitHub** — runs the same device flow as free-pi-cli
     (`/auth/github/device` → consent → poll `/auth/token`); open the link,
     enter the code, and the new account's JWT is validated and saved to
     `accounts.json` automatically
   - **Paste a token** — validated against `/me` first; saved to `accounts.json` (mode 0600)
3. **Fallback** — the free-pi CLI's own `~/.free-pi/agent/credentials.json`

Requests are distributed **round-robin** across enabled accounts. If an account
hits `concurrent_session` (4-session limit), the gateway calls
`POST /session/reset` (same as the CLI's `/close-other-session`) and retries;
if it still fails, the request **fails over to the next account**.

### Upstream sessions (why requests used to queue)

free-pi runs **one request at a time per `x-session-id`** and answers the rest
with `429 {"code":"concurrent"}`. It is stateless otherwise: the conversation
lives in the `messages` the client replays, not in the session.

Giving every request of an account the same id therefore serialised all clients
behind each other, and under load the gateway spent its attempts on 429s,
backed off 1.5 s and failed over — which looks like "the proxy is reusing an
old session". Each request now gets its own id (`sessionStrategy`), and a 429
`concurrent` mints a fresh id and retries immediately.

| strategy | session id | when to use |
|---|---|---|
| `request` (default) | fresh per request | many clients per account; nothing is ever shared |
| `conversation` | stable per conversation (system + first turn) | one upstream slot per chat |
| `account` | stable per account (hash of the token) | legacy behaviour; serialises clients |

`concurrent_session` (409, the token's session-slot limit) still triggers
`POST /session/reset`; a plain `concurrent` (429) does **not**, because a reset
closes the token's other sessions and would kill another client's stream.

## Admin UI

`http://127.0.0.1:8787/admin` — key required (`x-admin-key` header or the
prompt in the page). The key is printed at startup and stored in `.admin-key`
(override with `adminKey` in shi.json).

- Totals: requests, ok, errors, input/output tokens
- Accounts: label, source, masked token, enable/disable, per-account usage,
  last error; add (validated) and remove UI accounts
- Recent requests: last 200 with account, path, model, status, tokens, latency

## Config (shi.json)

| key | default | meaning |
|---|---|---|
| `port` / `host` | 8787 / 127.0.0.1 | listen address |
| `base` | https://api.freepi.ai | upstream |
| `cliVersion` | `auto` | `x-client-version`: `auto` follows `/client-version`; a concrete version pins a floor (upstream can still raise it) |
| `versionCheckMs` | 600000 (10 min) | how often `/client-version` is re-read |
| `defaultModel` | deepseek/deepseek-v4-flash | used when the requested model is unknown |
| `clientKeys` | [] | required API keys for /v1/* (empty = open) |
| `adminKey` | generated | admin UI key |
| `retry` | 3 × 500ms | 429/5xx backoff retries |
| `logRotate` | 10 MiB × 5 | size-based rotation of `gateway.log` (`gateway.log` → `gateway.1.log` …) |
| `maxInFlightPerAccount` | 4 | free-pi session limit; logs `account at session limit` when reached |
| `maxBufferedBytes` | 32 MiB | cap on a non-streaming response held in memory before it is sent |
| `sessionStrategy` | `request` | `request` \| `conversation` \| `account` — see above |
| `concurrentRotateRetries` | 2 | 429 `concurrent` → new session id and an immediate retry |
| `countTokensCharsPerToken` | 3.5 | divisor for `/v1/messages/count_tokens` (lower = more conservative) |
| `catalogFallbackTimeoutMs` | 5000 | bound on the authenticated catalog fetch |
| `resetOnConcurrent` | 2 resets | auto session-reset on concurrent_session |

## Tests

```bash
npm test          # node --test, no dependencies to install
```

The suite is self-contained: unit tests drive the translators with fake
streams, and `test/gateway.test.js` boots the real gateway against a mock
upstream on a scratch `DATA_DIR`, so no network or credentials are needed.

| file | covers |
|---|---|
| `test/stream.test.js` | stop-sequence hold-back, block protocol, malformed tool JSON |
| `test/lifecycle.test.js` | abort/drain listener hygiene, success-XOR-error terminal state |
| `test/accounts.test.js` | round-robin cursor purity (`pickOrder` vs `peekOrder`) |
| `test/session.test.js` | session-id strategies and conversation keying |
| `test/version.test.js` | version comparison, 426 minimum parsing, no-downgrade rule |
| `test/gateway.test.js` | content-length, 400s, stop sequences end-to-end, failover, single usage row, distinct session ids under concurrency, 429 `concurrent` rotation, 426 `upgrade_required` retry, 504 on timeout |

## Context window and upstream errors

The upstream catalog publishes **no** context length, so a client could only
discover the limit by having a request rejected. Two knobs are advertised on
`GET /v1/models` (OpenAI-compatible field names):

| env var | default | advertised as |
|---|---|---|
| `FREEPI_CONTEXT_WINDOW` | `200000` | `context_length` / `context_window` |
| `FREEPI_MAX_OUTPUT_TOKENS` | `8192` | `max_completion_tokens` |

`FREEPI_MAX_OUTPUT_TOKENS` defaults to the CLI's own cap (8192); advertising
more only makes responses stop with `finish_reason: "length"` for no reason.

Set `FREEPI_CONTEXT_WINDOW=0` to advertise nothing. Match these to the model you
actually route to — an advertised limit that is higher than the upstream's own
just moves the failure later.

Upstream errors are unwrapped rather than passed through as raw JSON, so
clients see a readable `message` plus the provider `code`
(e.g. `context_length_exceeded`). An error arriving **inside** a 200 SSE stream
is surfaced as an `error` event rather than a well-formed empty message.

## Finish reason mapping

Upstream `finish_reason` is translated to Anthropic `stop_reason` in
`src/translate/stop.js`, shared by the streaming and non-streaming paths so
they cannot disagree.

| OpenAI `finish_reason` | Anthropic `stop_reason` |
|---|---|
| `stop` / absent / unknown | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` / `function_call` | `tool_use` |
| `stop_sequence` | `stop_sequence` |
| `content_filter` | `refusal` |

A filtered response reports `refusal` rather than `end_turn`, so a client can
tell it apart from a natural stop.

## Run with Docker

```bash
cd repo-root
docker compose up -d --build        # gateway on http://localhost:8787
```

- State (accounts.json, logs, .admin-key) persists in the `freepi-data` volume.
  The container runs as the unprivileged `node` user, and `/app/data` is
  created owned by it, so a fresh volume is writable without root.
- Host `shi.json` is intentionally **not** baked into the image — configure via
  env vars instead: `ADMIN_KEY`, `PORT`, `HOST`, `DATA_DIR`,
  `FREEPI_CREDENTIALS_FILE`, `FREEPI_TOKEN_1..20` (in `.env`, picked up by
  `env_file`)
- `PORT` is honoured end to end: the published mapping and the healthcheck both
  follow it, so `PORT=9000` in `.env` serves on 9000. `docker compose up`
  runs with `init: true`, so `docker stop` delivers SIGTERM to the gateway and
  usage counters are flushed on shutdown.
- Add your first account from the admin UI (`http://localhost:8787/admin`) via
  the GitHub login flow — it survives restarts in the volume
- Optional: reuse the host CLI's signed-in account — uncomment the
  `FREEPI_CREDENTIALS_FILE` env and the credentials volume mount in
  `docker-compose.yml`

Manual run without compose:

```bash
docker build -t freepi-gateway .
docker run -d -p 8787:8787 -e ADMIN_KEY=change-me -v freepi-data:/app/data freepi-gateway
```

## Layout

```
index.js            entry point, admin key bootstrap
src/config.js       layered config: defaults <- shi.json <- env <- args
src/logger.js       leveled console + JSONL file log
src/accounts.js     multi-account store, round-robin, persistence
src/usage.js        per-account counters + recent requests, persisted
src/session.js      upstream session identity (request / conversation / account)
src/upstream.js     fingerprint client: retry, 401 reload, session rotation/reset
src/catalog.js      model catalog cache
src/version.js      x-client-version from GET /client-version (426 upgrade handling)
src/credentials.js  JWT load/refresh for the cli fallback account
src/admin.js        admin API + single-page UI
src/server.js       router, failover, usage recording
src/translate/      Anthropic <-> OpenAI translation (request/response/stream)
```

Logs: `logs/gateway.log` (JSONL, rotated in place), usage: `logs/usage.json`.

Each `response` line carries `account`, `attempts` (upstream tries incl. retries),
`failovers`, and `streamError` when a body copy broke mid-flight — in that case
the same request is counted as `502` in `usage.json`, not `200`.

Live concurrency is reported by `GET /health` (`inFlight` per account) and per
account as `inFlight` in `/admin/api/overview`; `account at session limit` warns
when an account reaches `maxInFlightPerAccount`.
