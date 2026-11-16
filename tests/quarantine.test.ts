import { after, afterEach, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

let server: Server;
let baseUrl: string;
// Every row these tests create starts with this, so after() can remove exactly those rows.
const MARKER = "quarantine-test-";

// These tests make several failing calls, and a failed call now counts toward the daily limit,
// so lift the limit for this file (restored in after()).
const originalLimit = process.env.DAILY_CHECK_LIMIT;

before(async () => {
  process.env.DAILY_CHECK_LIMIT = "1000000";
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(() => mock.restoreAll());

after(async () => {
  if (originalLimit === undefined) delete process.env.DAILY_CHECK_LIMIT;
  else process.env.DAILY_CHECK_LIMIT = originalLimit;
  // Failed calls are saved in checks too, so remove those rows as well.
  await pool.query("DELETE FROM checks WHERE text LIKE $1", [`${MARKER}%`]);
  await pool.query("DELETE FROM quarantine WHERE text LIKE $1", [`${MARKER}%`]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
});

// Replaces fetch for OpenRouter only; the test's own requests to the app still use the real fetch.
const realFetch = globalThis.fetch;
function fakeOpenRouter(answer: () => Response) {
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://openrouter.ai/")) return answer();
    return realFetch(input, init);
  });
}

// A successful OpenRouter response whose message content is the given model reply.
function modelReplies(content: string) {
  return () => new Response(JSON.stringify({ model: "fake/model", choices: [{ message: { content } }] }));
}

async function postCheck(text: string) {
  return realFetch(`${baseUrl}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rules: ["be nice"] }),
  });
}

async function quarantined(text: string) {
  const { rows } = await pool.query("SELECT rules, raw_reply, reason FROM quarantine WHERE text = $1", [text]);
  return rows;
}

// Each failing test below waits for the real 1 s retry delay.
test("an unusable reply is retried once; a good retry gives 200 and the bad reply is quarantined", async () => {
  const replies = [modelReplies("Sure! The text looks fine."), modelReplies('{"result": "pass", "reasons": []}')];
  let calls = 0;
  fakeOpenRouter(() => replies[calls++]!());
  mock.method(console, "warn", () => {});
  const text = MARKER + randomUUID();

  const res = await postCheck(text);
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(await quarantined(text), [
    { rules: ["be nice"], raw_reply: "Sure! The text looks fine.", reason: "Model reply was not valid JSON" },
  ]);
});

test("JSON in the wrong shape twice: both replies are quarantined and the request gets 503", async () => {
  fakeOpenRouter(modelReplies('{"verdict": "ok"}'));
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
  const text = MARKER + randomUUID();

  const res = await postCheck(text);
  assert.equal(res.status, 503);
  const rows = await quarantined(text);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.raw_reply, '{"verdict": "ok"}');
    assert.match(row.reason, /did not match/);
  }
});

test("a failed quarantine insert is logged and the request still gets 503", async () => {
  fakeOpenRouter(modelReplies("not json"));
  const realQuery = pool.query.bind(pool);
  mock.method(pool, "query", async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("INSERT INTO quarantine")) throw new Error("disk full");
    return realQuery(sql, params);
  });
  mock.method(console, "warn", () => {});
  const consoleError = mock.method(console, "error", () => {});

  const res = await postCheck(MARKER + randomUUID());
  assert.equal(res.status, 503);
  const messages = consoleError.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(messages.includes("Failed to save unusable reply to quarantine:"));
  // The original model error still reaches the error handler.
  assert.ok(messages.includes("Model unavailable:"));
});

test("a network error is not quarantined", async () => {
  fakeOpenRouter(() => {
    throw new TypeError("fetch failed");
  });
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
  const text = MARKER + randomUUID();

  const res = await postCheck(text);
  assert.equal(res.status, 503);
  assert.deepEqual(await quarantined(text), []);
});
