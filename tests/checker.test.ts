import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { checkText, ModelError, ModelUnavailableError, UnusableReplyError } from "../src/checker.js";
import { errorHandler } from "../src/app.js";

// Every test passes a fake fetch, so no request ever reaches OpenRouter.
// Short timeouts and no retry delay keep the tests fast.
const fast = { timeoutMs: 50, retryDelayMs: 0 };

function okResponse(content = '{"result": "pass", "reasons": []}'): Response {
  const body = { model: "fake/model", choices: [{ message: { content } }] };
  return new Response(JSON.stringify(body), { status: 200 });
}

// Builds a fake fetch that plays the given steps in order and counts how often it was called.
// A step is a status code to answer with, "network" to throw like a dropped connection,
// "hang" to never answer until the request is aborted, or "unusable" for a 200 whose reply isn't valid JSON.
function fakeFetch(steps: (number | "network" | "hang" | "unusable")[]) {
  let calls = 0;
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const step = steps[calls++];
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "hang") {
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (step === 200) return okResponse();
    if (step === "unusable") return okResponse("Sure! The text looks fine.");
    return new Response("upstream error", { status: step });
  }) as typeof fetch;
  return { fn, calls: () => calls };
}

test("returns the result on the first try", async () => {
  const fake = fakeFetch([200]);
  const outcome = await checkText("hi", ["be nice"], { ...fast, fetch: fake.fn });
  assert.deepEqual(outcome, { result: "pass", reasons: [], model: "fake/model" });
  assert.equal(fake.calls(), 1);
});

test("retries once on 5xx, 429, network errors, timeouts and unusable replies, then succeeds", async () => {
  for (const failure of [503, 429, 500, "network", "hang", "unusable"] as const) {
    const fake = fakeFetch([failure, 200]);
    const outcome = await checkText("hi", ["be nice"], { ...fast, fetch: fake.fn });
    assert.equal(outcome.result, "pass", `after ${failure}`);
    assert.equal(fake.calls(), 2, `after ${failure}`);
  }
});

test("gives up after 1 retry and throws ModelUnavailableError", async () => {
  const fake = fakeFetch([500, 502, 200]);
  await assert.rejects(checkText("hi", ["be nice"], { ...fast, fetch: fake.fn }), (err) => {
    assert.ok(err instanceof ModelUnavailableError);
    assert.match(err.message, /502/);
    return true;
  });
  assert.equal(fake.calls(), 2);
});

test("does not retry config errors (400, 401, 403)", async () => {
  for (const status of [400, 401, 403]) {
    const fake = fakeFetch([status, 200]);
    await assert.rejects(checkText("hi", ["be nice"], { ...fast, fetch: fake.fn }), (err) => {
      assert.ok(err instanceof ModelError);
      assert.ok(!(err instanceof ModelUnavailableError));
      return true;
    });
    assert.equal(fake.calls(), 1, `after ${status}`);
  }
});

test("timing out twice throws ModelUnavailableError", async () => {
  const fake = fakeFetch(["hang", "hang", "hang"]);
  await assert.rejects(checkText("hi", ["be nice"], { ...fast, fetch: fake.fn }), ModelUnavailableError);
  assert.equal(fake.calls(), 2);
});

test("onFailedAttempt is called once per failed request, with the unusable reply", async () => {
  const failures: ModelError[] = [];
  const onFailedAttempt = async (err: ModelError) => {
    failures.push(err);
  };
  const fake = fakeFetch(["unusable", "network"]);
  await assert.rejects(
    checkText("hi", ["be nice"], { ...fast, fetch: fake.fn, onFailedAttempt }),
    ModelUnavailableError,
  );
  assert.equal(failures.length, 2);
  assert.ok(failures[0] instanceof UnusableReplyError);
  assert.equal(failures[0].rawReply, "Sure! The text looks fine.");

  const config = fakeFetch([401]);
  failures.length = 0;
  await assert.rejects(checkText("hi", ["be nice"], { ...fast, fetch: config.fn, onFailedAttempt }), ModelError);
  assert.equal(failures.length, 1);
});

test("an error thrown by beforeRetry stops the retry and is passed on", async () => {
  const fake = fakeFetch([503, 200]);
  const stop = new Error("no retry");
  await assert.rejects(
    checkText("hi", ["be nice"], { ...fast, fetch: fake.fn, beforeRetry: async () => { throw stop; } }),
    (err) => err === stop,
  );
  assert.equal(fake.calls(), 1);
});

// Calls the error handler directly with a minimal stand-in for Express's res.
function respond(err: unknown): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const res = {
    headersSent: false,
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as ExpressResponse;
  errorHandler(err, {} as ExpressRequest, res, () => {});
  return { status, body };
}

test("error handler maps an unavailable model to 503 and other model failures to 502", (t) => {
  t.mock.method(console, "error", () => {});
  assert.deepEqual(respond(new ModelUnavailableError("down")), {
    status: 503,
    body: {
      error: "model_unavailable",
      message: "The model isn't responding right now. Please try again in a few minutes.",
    },
  });
  assert.equal(respond(new ModelError("broken")).status, 502);
});
