import express, { type ErrorRequestHandler } from "express";
import { checkText, ModelError, ModelTimeoutError, UnusableReplyError } from "./checker.js";
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
// so the caller can still rethrow the original model error and answer 502.
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

app.post("/check", async (req, res) => {
  if (!isCheckRequest(req.body)) {
    res.status(400).json({ error: "Body must be { text: string, rules: string[] }" });
    return;
  }
  // Express 5 forwards a rejected promise to the error handler below,
  // so a failed model call or a failed insert never reaches res.json.
  const { text, rules } = req.body;
  let outcome;
  try {
    outcome = await checkText(text, rules);
  } catch (err) {
    // Only replies the model actually sent go to quarantine; timeouts and network errors have nothing to keep.
    if (err instanceof UnusableReplyError) await quarantine(text, rules, err);
    throw err;
  }
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
  // Checked before ModelError because ModelTimeoutError is a subclass of it.
  if (err instanceof ModelTimeoutError) {
    console.error("Model call timed out:", err.message);
    res.status(504).json({ error: "The checking model took too long to answer" });
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
