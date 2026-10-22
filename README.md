# ai-output-checker

A small HTTP service that checks a piece of AI-generated text against a list of rules.

**Status: skeleton.** `POST /check` currently returns `{ "result": "pass" }` for any valid input. There is no LLM call, no auth, and no payments yet.

## Requirements

- Node.js 20.6 or newer (needed for `--env-file`)
- Docker (for Postgres)

## Setup

```sh
npm install
cp .env.example .env      # then edit the values, at least the password
docker compose up -d      # starts Postgres 16 in the background
npm run db:check          # should print "Database connection OK"
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
# {"result":"pass"}
```

A body that isn't `{ text: string, rules: string[] }` gets a `400` response.

## Scripts

| Command             | What it does                                 |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Run the server, restarting on file changes   |
| `npm start`         | Run the server once                          |
| `npm run db:check`  | Connect to Postgres and run `SELECT 1`       |
| `npm run typecheck` | Type-check the code without running it       |

## Project layout

```
src/
  db.ts         Postgres connection pool and health check
  server.ts     Express app and the POST /check route
tests/          Tests (none yet)
docker-compose.yml   Local Postgres 16
.env.example         Template for required environment variables
```

## Stopping Postgres

```sh
docker compose stop       # stop, keep data
docker compose down -v    # stop and delete all data
```
