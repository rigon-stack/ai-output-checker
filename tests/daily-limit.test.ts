import { after, afterEach, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch;
const originalLimit = process.env.DAILY_CHECK_LIMIT;

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  mock.restoreAll();
  if (originalLimit === undefined) delete process.env.DAILY_CHECK_LIMIT;
  else process.env.DAILY_CHECK_LIMIT = originalLimit;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
});

function post(text: string) {
  return realFetch(`${baseUrl}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rules: ["be nice"] }),
  });
}

test("over the daily limit: 429 with body and Retry-After, no model call, no row", async () => {
  process.env.DAILY_CHECK_LIMIT = "2";
  // Pretend 2 checks were already made today; record every other query so we can prove no row is inserted.
  const otherQueries: string[] = [];
  mock.method(pool, "query", async (sql: string) => {
    if (sql.includes("count(*)")) return { rows: [{ count: 2 }] };
    otherQueries.push(sql);
    throw new Error("no other query expected");
  });
  let modelCalls = 0;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://openrouter.ai/")) {
      modelCalls++;
      throw new Error("model must not be called");
    }
    return realFetch(input, init);
  });
  const text = `daily-limit-test-${randomUUID()}`;

  const before = Date.now();
  const res = await post(text);
  assert.equal(res.status, 429);

  const body = (await res.json()) as { error: string; limit: number; resetsAt: string };
  assert.equal(body.error, "daily_limit_reached");
  assert.equal(body.limit, 2);
  const resetsAt = new Date(body.resetsAt);
  assert.equal(resetsAt.toISOString(), body.resetsAt);
  assert.equal(resetsAt.getUTCHours() + resetsAt.getUTCMinutes() + resetsAt.getUTCSeconds(), 0);
  assert.ok(resetsAt.getTime() > before && resetsAt.getTime() - before <= 24 * 3600 * 1000);

  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86400);
  assert.ok(Math.abs(retryAfter - (resetsAt.getTime() - before) / 1000) <= 2);

  assert.equal(modelCalls, 0);
  assert.deepEqual(otherQueries, []);
});

test("a failed count query gives 500 and does not call the model", async () => {
  let modelCalls = 0;
  const realQuery = pool.query.bind(pool);
  mock.method(pool, "query", async (sql: string, params?: unknown[]) => {
    if (sql.includes("count(*)")) throw new Error("db down");
    return realQuery(sql, params);
  });
  mock.method(console, "error", () => {});
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://openrouter.ai/")) {
      modelCalls++;
      throw new Error("model must not be called");
    }
    return realFetch(input, init);
  });

  const res = await post(`daily-limit-test-${randomUUID()}`);
  assert.equal(res.status, 500);
  assert.equal(modelCalls, 0);
});

test("a config error (400) is not retried and uses up one check from the daily limit", async () => {
  // Real database: allow exactly one more check today, whatever is already there.
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM checks WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
  );
  process.env.DAILY_CHECK_LIMIT = String(rows[0]!.count + 1);
  let modelCalls = 0;
  // A 400 is not retried, so the model call fails straight away.
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://openrouter.ai/")) {
      modelCalls++;
      return new Response("bad request", { status: 400 });
    }
    return realFetch(input, init);
  });
  mock.method(console, "error", () => {});
  const text = `daily-limit-test-${randomUUID()}`;

  try {
    const first = await post(text);
    assert.equal(first.status, 502);
    assert.equal(modelCalls, 1);

    // The failed call used the last check, so the next one is refused without calling the model.
    const second = await post(`${text}-again`);
    assert.equal(second.status, 429);
    assert.equal(modelCalls, 1);
  } finally {
    await pool.query("DELETE FROM checks WHERE text LIKE $1", [`${text}%`]);
  }
});

// Allows exactly `extra` more checks today, whatever is already in the real database.
async function allowMore(extra: number) {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM checks WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
  );
  process.env.DAILY_CHECK_LIMIT = String(rows[0]!.count + extra);
}

// Answers OpenRouter calls with the given statuses in order (200 = a valid reply) and counts them.
function fakeOpenRouter(statuses: number[]) {
  let calls = 0;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith("https://openrouter.ai/")) return realFetch(input, init);
    const status = statuses[calls++]!;
    if (status !== 200) return new Response("upstream error", { status });
    const content = '{"result": "pass", "reasons": []}';
    return new Response(JSON.stringify({ model: "fake/model", choices: [{ message: { content } }] }));
  });
  return () => calls;
}

// Each test below waits for the real 1 s retry delay.
test("a failed first try followed by a good retry gives 200, and both requests count", async () => {
  await allowMore(2);
  const modelCalls = fakeOpenRouter([503, 200]);
  mock.method(console, "warn", () => {});
  const text = `daily-limit-test-${randomUUID()}`;

  try {
    const first = await post(text);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { result: "pass", reasons: [] });
    assert.equal(modelCalls(), 2);
    const { rows } = await pool.query("SELECT status FROM checks WHERE text = $1 ORDER BY id", [text]);
    assert.deepEqual(rows, [{ status: "failed" }, { status: "ok" }]);

    const second = await post(`${text}-again`);
    assert.equal(second.status, 429);
    assert.equal(modelCalls(), 2);
  } finally {
    await pool.query("DELETE FROM checks WHERE text LIKE $1", [`${text}%`]);
  }
});

test("both tries failing gives 503 model_unavailable, and both requests count", async () => {
  await allowMore(2);
  const modelCalls = fakeOpenRouter([503, 503, 200]);
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
  const text = `daily-limit-test-${randomUUID()}`;

  try {
    const first = await post(text);
    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), {
      error: "model_unavailable",
      message: "The model isn't responding right now. Please try again in a few minutes.",
    });
    assert.equal(modelCalls(), 2);

    const second = await post(`${text}-again`);
    assert.equal(second.status, 429);
    assert.equal(modelCalls(), 2);
  } finally {
    await pool.query("DELETE FROM checks WHERE text LIKE $1", [`${text}%`]);
  }
});

test("one check left and the first try fails: no retry, 429 with Retry-After, exactly 1 row", async () => {
  await allowMore(1);
  const modelCalls = fakeOpenRouter([503, 200]);
  const text = `daily-limit-test-${randomUUID()}`;

  try {
    const res = await post(text);
    assert.equal(res.status, 429);
    const body = (await res.json()) as { error: string; limit: number; resetsAt: string };
    assert.equal(body.error, "daily_limit_reached");
    assert.equal(body.limit, Number(process.env.DAILY_CHECK_LIMIT));
    const retryAfter = Number(res.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86400);

    assert.equal(modelCalls(), 1);
    const { rows } = await pool.query("SELECT status FROM checks WHERE text = $1", [text]);
    assert.deepEqual(rows, [{ status: "failed" }]);
  } finally {
    await pool.query("DELETE FROM checks WHERE text LIKE $1", [`${text}%`]);
  }
});
