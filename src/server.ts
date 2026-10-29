import { app } from "./app.js";
import { checkDb, pool } from "./db.js";

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
