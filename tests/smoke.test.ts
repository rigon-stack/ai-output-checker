import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

let server: Server;
let baseUrl: string;

// Port 0 lets the OS pick a free port, so tests never clash with a running dev server.
before(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
});

test("GET /health returns 200 with { ok: true }", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// Rejected by validation before checkText runs, so the model is never called.
test("POST /check with an invalid body returns 400", async () => {
  const res = await fetch(`${baseUrl}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});
