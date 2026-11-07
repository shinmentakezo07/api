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

1. **`.env`** (read-only in the UI):
   - `FREEPI_ACCOUNTS=token1,token2` or `FREEPI_ACCOUNTS=["tok1","tok2"]`
   - or `FREEPI_TOKEN_1=...`, `FREEPI_TOKEN_2=...` (up to 20)
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

Each account gets a stable `x-session-id` (hash of its token) so restarts
reuse the same backend session slots.

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
| `defaultModel` | deepseek/deepseek-v4-flash | used when the requested model is unknown |
| `clientKeys` | [] | required API keys for /v1/* (empty = open) |
| `adminKey` | generated | admin UI key |
| `retry` | 3 × 500ms | 429/5xx backoff retries |
| `resetOnConcurrent` | 2 resets | auto session-reset on concurrent_session |

## Layout

```
index.js            entry point, admin key bootstrap
src/config.js       layered config: defaults <- shi.json <- env <- args
src/logger.js       leveled console + JSONL file log
src/accounts.js     multi-account store, round-robin, persistence
src/usage.js        per-account counters + recent requests, persisted
src/upstream.js     fingerprint client: retry, 401 reload, session reset
src/catalog.js      model catalog cache
src/credentials.js  JWT load/refresh for the cli fallback account
src/admin.js        admin API + single-page UI
src/server.js       router, failover, usage recording
src/translate/      Anthropic <-> OpenAI translation (request/response/stream)
```

Logs: `logs/gateway.log` (JSONL), usage: `logs/usage.json`.
