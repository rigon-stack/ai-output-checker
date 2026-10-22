import { pathToFileURL } from "node:url";
import express from "express";
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

app.post("/check", (req, res) => {
  if (!isCheckRequest(req.body)) {
    res.status(400).json({ error: "Body must be { text: string, rules: string[] }" });
    return;
  }
  // Placeholder: no real checking yet, every input passes.
  res.json({ result: "pass" });
});

// Start the server when this file is run directly: `npm run dev` / `npm start`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkDb();
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => {
    console.log(`ai-output-checker listening on http://localhost:${port}`);
  });

  const shutdown = () => {
    server.close(() => void pool.end());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
