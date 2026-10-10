// Run from the project root: node app/api/rooms/test-api.mjs
// Tests the route against Miniflare's real D1 implementation in an isolated DB.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import { createRoomDatabase } from "./database.mjs";


const db = createRoomDatabase();
try {
  globalThis.__roomTestEnv = { DB: db };
  const source = (await fs.readFile("./app/api/rooms/route.ts", "utf8"))
    .replace('import { env } from "cloudflare:workers";', "const env = globalThis.__roomTestEnv;");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const { POST } = await import("data:text/javascript;base64," + Buffer.from(javascript).toString("base64"));
  async function api(body) {
    const response = await POST(new Request("https://test.example/api/rooms", { method: "POST", body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  }

  const host = await api({ action: "create" });
  assert.equal(host.status, 201);
  assert.match(host.room.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  const code = host.room.code;
  const [first, second] = await Promise.all([api({ action: "join", code }), api({ action: "join", code })]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409], "simultaneous joins admit exactly one guest");
  const guest = first.status === 200 ? first : second;
  assert.equal((await api({ action: "sync", code, token: "a".repeat(48) })).status, 403);
  const h = await api({ action: "sync", code, token: host.token });
  assert.equal(h.peerConnected, true);
  assert.equal(h.session, guest.session);
  const state = {
    session: h.session,
    realtime: { seq: 2, data: { type: "state", state: { scores: [1, 0], ball: { x: 0.5 } } } },
    reliable: [{ seq: 1, data: { type: "serve" } }], ack: 0,
  };
  assert.equal((await api({ action: "sync", code, token: host.token, mailbox: state })).status, 200);
  const received = await api({
    action: "sync", code, token: guest.token,
    mailbox: { session: h.session, realtime: { seq: 1, data: { type: "input", input: { x: 0.8 } } }, reliable: [], ack: 1 },
  });
  assert.deepEqual(received.mailbox, state, "D1 relays state and controls across players");
  const ack = await api({ action: "sync", code, token: host.token });
  assert.equal(ack.mailbox.ack, 1);
  assert.equal(ack.mailbox.realtime.data.input.x, 0.8);
  const spoof = { ...state, realtime: { seq: 3, data: { type: "state", state: {} } } };
  assert.equal((await api({ action: "sync", code, token: guest.token, mailbox: spoof })).status, 400, "guest cannot publish authoritative state");
  assert.equal((await api({ action: "sync", code, token: host.token, signal: { type: "answer", sdp: "x", id: "bad" } })).status, 400);
  assert.equal((await api({ action: "leave", code, token: guest.token })).status, 200);
  assert.equal((await api({ action: "sync", code, token: host.token })).peerConnected, false);
  const guest2 = await api({ action: "join", code });
  assert.equal(guest2.status, 200);
  assert.notEqual(guest2.session, guest.session);
  assert.equal((await api({ action: "sync", code, token: guest.token })).status, 403, "departed guest token is revoked");
  await db.prepare("UPDATE rooms SET host_seen = ? WHERE code = ?").bind(Date.now() - 46_000, code).run();
  assert.equal((await api({ action: "sync", code, token: guest2.token })).status, 410, "offline host detected");
  await api({ action: "leave", code, token: host.token });
  assert.equal((await api({ action: "join", code })).status, 404);
  const oversized = await POST(new Request("https://test.example/api/rooms", { method: "POST", body: "x".repeat(65_000) }));
  assert.equal(oversized.status, 413);
  console.log("PASS: Node SQLite migration, room creation, atomic capacity, authorization, relay, validation, leave/rejoin, timeout and body limits");
} finally {
  db.close();
}
