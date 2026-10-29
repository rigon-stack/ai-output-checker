import { readdir, readFile } from "node:fs/promises";
import { pool } from "./db.js";

// Runs every .sql file in migrations/ in filename order (001_, 002_, ...).
// Migrations must be idempotent (e.g. CREATE TABLE IF NOT EXISTS) since every run replays them all.
const dir = new URL("../migrations/", import.meta.url);

try {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await pool.query(await readFile(new URL(file, dir), "utf8"));
    console.log(`Applied ${file}`);
  }
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
