import express, { type ErrorRequestHandler } from "express";
import { checkText, ModelError } from "./checker.js";
import { checkDb } from "./db.js";

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

app.post("/check", async (req, res) => {
  if (!isCheckRequest(req.body)) {
    res.status(400).json({ error: "Body must be { text: string, rules: string[] }" });
    return;
  }
  // Express 5 forwards a rejected promise to the error handler below.
  const { result, reasons } = await checkText(req.body.text, req.body.rules);
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

// Catch-all error handler: always answer with JSON instead of Express's HTML stack-trace page.
// Registered after the routes so it sees errors from all of them.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
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
