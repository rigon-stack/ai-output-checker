# ai-output-checker

A small HTTP service that checks a piece of AI-generated text against a list of rules.

`POST /check` sends the text and rules to a model on OpenRouter (`openrouter/free` by default, set `OPENROUTER_MODEL` to change it) and returns `{ result, reasons }`. Every check is saved to the `checks` table in Postgres. There is no auth and no payments yet.

## Requirements

- Node.js 20.6 or newer (needed for `--env-file`)
- Docker (for Postgres)

## Setup

```sh
npm install
cp .env.example .env      # then edit the values: the password and OPENROUTER_API_KEY
docker compose up -d      # starts Postgres 16 in the background
npm run db:check          # should print "Database connection OK"
npm run migrate           # creates the checks and quarantine tables
```

If you change the password in `.env`, update it in both `POSTGRES_PASSWORD` and `DATABASE_URL`.

## Run

```sh
npm run dev               # starts the server and restarts it on file changes
```

The server listens on `http://localhost:3000` (set `PORT` in `.env` to change it).

```sh
curl -X POST http://localhost:3000/check \
  -H 'content-type: application/json' \
  -d '{"text": "Hello world", "rules": ["no profanity"]}'
# {"result":"pass","reasons":[]}
```

`result` is `"pass"` or `"flag"`, with one reason per broken rule. A body that isn't `{ text: string, rules: string[] }` gets a `400`, a failed or unusable model reply gets a `502` (or a `504` if it timed out after retries), and a failed database insert gets a `500`.

`GET /health` returns `{ "ok": true }` if the database answers, otherwise `503` with `{ "ok": false }`.

## Scripts

| Command             | What it does                                 |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Run the server, restarting on file changes   |
| `npm start`         | Run the server once                          |
| `npm run db:check`  | Connect to Postgres and run `SELECT 1`       |
| `npm run migrate`   | Run the SQL files in `migrations/` in order  |
| `npm test`          | Run the smoke tests (needs Docker up)        |
| `npm run typecheck` | Type-check the code without running it       |

## Project layout

```
src/
  app.ts        Express app: POST /check, GET /health, JSON error handler
  server.ts     Starts the app on PORT
  checker.ts    checkText: calls OpenRouter and validates the reply
  db.ts         Postgres connection pool and health check
  migrate.ts    Runs the migrations
migrations/     SQL migrations (001_create_checks.sql, 002_create_quarantine.sql)
tests/          Smoke tests (node:test), no model calls
docker-compose.yml   Local Postgres 16
.env.example         Template for required environment variables
```

## Stopping Postgres

```sh
docker compose stop       # stop, keep data
docker compose down -v    # stop and delete all data
```
