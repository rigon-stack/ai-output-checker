# ai-output-checker

[![CI](https://github.com/rigon-stack/ai-output-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/rigon-stack/ai-output-checker/actions/workflows/ci.yml)

A small HTTP service that checks AI-generated text against your own rules before you use it.
You send the text and a list of rules; a model (via OpenRouter) says whether the text passes or should be flagged, and why. Every check is saved to Postgres.

## Endpoints

### `POST /check`

```json
{ "text": "string", "rules": ["string", "..."] }
```

Returns:

```json
{ "result": "pass" | "flag", "reasons": ["..."] }
```

| Status | When |
|---|---|
| 400 | The body is invalid |
| 429 | The daily limit is reached (`Retry-After` header included) |
| 502 | OpenRouter config error (400/401/403), not retried |
| 503 | `model_unavailable`: a temporary model error happened twice |
| 500 | Database error |

### `GET /health`

`{ "ok": true }`, or `503` with `{ "ok": false }` if the database doesn't answer.

Any other route returns a JSON 404.

## How it behaves

- **Retries once** on network errors, the 20 s timeout, OpenRouter 429/5xx and unusable model replies. Never on 400/401/403.
- **Daily limit** (`DAILY_CHECK_LIMIT`, default 50). Failed model calls count toward it too, and it's re-checked before a retry.
- **Every check is stored.** If saving fails, the request fails with 500, so there's never a check without a record.
- **Unusable model replies** are saved to a separate quarantine table for inspection.
- Uses `openrouter/free` by default. There's no auth yet.

## Run it locally

Needs Node ≥ 20.6 and Docker.

```bash
npm install
cp .env.example .env      # set the password and OPENROUTER_API_KEY
docker compose up -d      # Postgres 16
npm run db:check
npm run migrate           # migrations 001–003
npm run dev               # http://localhost:3000
```

## Tests

```bash
npm test          # node:test, needs the Postgres container running
npm run typecheck
```

## Environment variables

`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `DATABASE_URL`, `PORT`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `DAILY_CHECK_LIMIT`

## Stack

TypeScript, Express, PostgreSQL, OpenRouter, node:test, Docker
