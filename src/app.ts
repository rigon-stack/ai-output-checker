import express, { type ErrorRequestHandler, type Response } from "express";
import { checkText, ModelError, ModelUnavailableError, UnusableReplyError } from "./checker.js";
import { checkDb, pool } from "./db.js";

export const app = express();
app.use(express.json({ limit: "1mb" }));

type CheckRequest = { text: string; rules: string[] };

function isCheckRequest(body: unknown): body is CheckRequest {
  if (typeof body !== "object" || body === null) return false;
  const { text, rules } = body as Record<string, unknown>;
  return (
    typeof text === "string" &&
    Array.isArray(rules) &&
    rules.every((rule) => typeof rule === "string")
  );
}

// Saves an unusable model reply for later inspection. Never throws: a failed insert is only logged,
// so the model call can carry on (retry or fail) as if nothing happened.
async function quarantine(text: string, rules: string[], err: UnusableReplyError): Promise<void> {
  try {
    await pool.query(
      "INSERT INTO quarantine (text, rules, raw_reply, reason) VALUES ($1, $2, $3, $4)",
      [text, JSON.stringify(rules), err.rawReply, err.reason],
    );
  } catch (insertErr) {
    console.error("Failed to save unusable reply to quarantine:", insertErr);
  }
}

// Saves a failed request to OpenRouter so it counts toward the daily limit. Never throws: a failed insert is only logged,
// so the model call can carry on (retry or fail) as if nothing happened.
async function recordFailedCheck(text: string, rules: string[]): Promise<void> {
  try {
    await pool.query("INSERT INTO checks (text, rules, status) VALUES ($1, $2, 'failed')", [text, JSON.stringify(rules)]);
  } catch (insertErr) {
    console.error("Failed to record failed check:", insertErr);
  }
}

// Read on every request so the limit can be changed without a restart (and in tests).
function dailyCheckLimit(): number {
  const limit = Number(process.env.DAILY_CHECK_LIMIT);
  return process.env.DAILY_CHECK_LIMIT?.trim() && Number.isFinite(limit) && limit >= 0 ? limit : 50;
}

// Thrown when the daily limit is reached before a retry; the error handler answers it like the normal limit.
class DailyLimitReachedError extends Error {
  override name = "DailyLimitReachedError";
  constructor(readonly limit: number) {
    super(`Daily check limit of ${limit} reached`);
  }
}

// Number of checks made today (UTC), failed ones included. A failing query rejects and becomes a 500.
async function checksToday(): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM checks WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
  );
  return rows[0]!.count;
}

// 429 with Retry-After pointing at the next UTC midnight, when the count starts again.
function sendDailyLimitReached(res: Response, limit: number): void {
  const now = new Date();
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  res
    .status(429)
    .set("Retry-After", String(Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)))
    .json({ error: "daily_limit_reached", limit, resetsAt: resetsAt.toISOString() });
}

app.post("/check", async (req, res) => {
  if (!isCheckRequest(req.body)) {
    res.status(400).json({ error: "Body must be { text: string, rules: string[] }" });
    return;
  }
  // Express 5 forwards a rejected promise to the error handler below,
  // so a failed model call or a failed insert never reaches res.json.
  const { text, rules } = req.body;

  // Daily limit: checked before the model is called. A failing count query rejects and becomes a 500.
  const limit = dailyCheckLimit();
  if ((await checksToday()) >= limit) {
    sendDailyLimitReached(res, limit);
    return;
  }

  // Runs after every failed request to OpenRouter, so a retry is counted and quarantined like the first try.
  const outcome = await checkText(text, rules, {
    onFailedAttempt: async (err) => {
      // Only replies the model actually sent go to quarantine; timeouts and network errors have nothing to keep.
      if (err instanceof UnusableReplyError) await quarantine(text, rules, err);
      // Every request we sent uses up one check from the daily limit, so a failed one gets a row too.
      await recordFailedCheck(text, rules);
    },
    // A retry is another request against the limit, and the failed try above already used one, so check again.
    beforeRetry: async () => {
      if ((await checksToday()) >= limit) throw new DailyLimitReachedError(limit);
    },
  });
  const { result, reasons, model } = outcome;
  // JSON.stringify because pg would otherwise send JS arrays as Postgres arrays, not JSONB.
  await pool.query(
    "INSERT INTO checks (text, rules, result, reasons, model) VALUES ($1, $2, $3, $4, $5)",
    [text, JSON.stringify(rules), result, JSON.stringify(reasons), model],
  );
  res.json({ result, reasons });
});

app.get("/health",async (req, res) => {
  try {
    await checkDb();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false })
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "This route doesnt exist" });
  return;
})

// Catch-all error handler: always answer with JSON instead of Express's HTML stack-trace page.
// Registered after the routes so it sees errors from all of them.
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof DailyLimitReachedError) {
    sendDailyLimitReached(res, err.limit);
    return;
  }
  // Checked before ModelError because ModelUnavailableError is a subclass of it.
  if (err instanceof ModelUnavailableError) {
    console.error("Model unavailable:", err.message);
    res.status(503).json({
      error: "model_unavailable",
      message: "The model isn't responding right now. Please try again in a few minutes.",
    });
    return;
  }
  if (err instanceof ModelError) {
    console.error("Model call failed:", err.message);
    res.status(502).json({ error: "The checking model failed or returned an unusable reply" });
    return;
  }
  // Errors from express.json() (malformed JSON, body too large) carry a 4xx status and a safe message.
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error("Unhandled error:", err);
  res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
};
app.use(errorHandler);
