import { pathToFileURL } from "node:url";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// One shared pool for the whole app; it opens connections on demand and reuses them.
export const pool = new pg.Pool({ connectionString });

export async function checkDb(): Promise<void> {
  const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
  if (rows[0]?.ok !== 1) {
    throw new Error("Unexpected response from SELECT 1");
  }
}

// Allow running this file directly: `npm run db:check`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkDb();
    console.log("Database connection OK");
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
