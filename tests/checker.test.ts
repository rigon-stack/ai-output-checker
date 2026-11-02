import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { checkText, ModelError, ModelTimeoutError } from "../src/checker.js";
import { errorHandler } from "../src/app.js";

// Every test passes a fake fetch, so no request ever reaches OpenRouter.
// Short timeouts and no retry delay keep the tests fast.
const fast = { timeoutMs: 50, retryDelayMs: 0 };

function okResponse(): Response {
  const body = {
    model: "fake/model",
    choices: [{ message: { content: '{"result": "pass", "reasons": []}' } }],
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

// Builds a fake fetch that plays the given steps in order and counts how often it was called.
// A step is a status code to answer with, "network" to throw like a dropped connection,
// or "hang" to never answer until the request is aborted.
function fakeFetch(steps: (number | "network" | "hang")[]) {
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

test("retries on 5xx, 429 and network errors, then succeeds", async () => {
  const fake = fakeFetch([503, 429, 200]);
  await checkText("hi", ["be nice"], { ...fast, fetch: fake.fn });
  assert.equal(fake.calls(), 3);

  const network = fakeFetch(["network", 200]);
  await checkText("hi", ["be nice"], { ...fast, fetch: network.fn });
  assert.equal(network.calls(), 2);
});

test("gives up after 2 retries and throws ModelError", async () => {
  const fake = fakeFetch([500, 502, 503, 200]);
  await assert.rejects(checkText("hi", ["be nice"], { ...fast, fetch: fake.fn }), (err) => {
    assert.ok(err instanceof ModelError);
    assert.ok(!(err instanceof ModelTimeoutError));
    assert.match(err.message, /503/);
    return true;
  });
  assert.equal(fake.calls(), 3);
});

test("does not retry other 4xx errors", async () => {
  const fake = fakeFetch([401, 200]);
  await assert.rejects(checkText("hi", ["be nice"], { ...fast, fetch: fake.fn }), ModelError);
  assert.equal(fake.calls(), 1);
});

test("a request that hangs times out, is retried, and recovers", async () => {
  const fake = fakeFetch(["hang", 200]);
  const outcome = await checkText("hi", ["be nice"], { ...fast, fetch: fake.fn });
  assert.equal(outcome.result, "pass");
  assert.equal(fake.calls(), 2);
});

test("timing out on every try throws ModelTimeoutError", async () => {
  const fake = fakeFetch(["hang", "hang", "hang"]);
  await assert.rejects(checkText("hi", ["be nice"], { ...fast, fetch: fake.fn }), ModelTimeoutError);
  assert.equal(fake.calls(), 3);
});

// Calls the error handler directly with a minimal stand-in for Express's res.
function statusFor(err: unknown): number {
  let status = 0;
  const res = {
    headersSent: false,
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as ExpressResponse;
  errorHandler(err, {} as ExpressRequest, res, () => {});
  return status;
}

test("error handler maps a timeout to 504 and other model failures to 502", () => {
  assert.equal(statusFor(new ModelTimeoutError("slow")), 504);
  assert.equal(statusFor(new ModelError("broken")), 502);
});
