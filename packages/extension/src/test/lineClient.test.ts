import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@agent-sessions/daemon";
import { LineClient, type LineClientEvents } from "../connection/lineClient.js";

function harness(opts = {}) {
  const fromDaemon = new PassThrough();
  const toDaemon = new PassThrough();
  const sentToDaemon: string[] = [];
  toDaemon.on("data", (d) => sentToDaemon.push(...String(d).trim().split("\n")));
  const calls: string[] = [];
  const events: LineClientEvents = {
    onHello: (i) => calls.push(`hello:${i.daemonVersion}`),
    onSnapshot: (s) => calls.push(`snapshot:${s.length}`),
    onChanged: (u, r) => calls.push(`changed:${u.length}:${r.length}`),
    onError: (m) => calls.push(`error:${m}`),
    onWarning: (m) => calls.push(`warning:${m}`),
    onClose: () => calls.push("close"),
  };
  const client = new LineClient(fromDaemon, toDaemon, events, { pingIntervalMs: 20, pongTimeoutMs: 30, helloTimeoutMs: 50, ...opts });
  return { fromDaemon, toDaemon, sentToDaemon, calls, client };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hello = `{"type":"hello","protocol":${PROTOCOL_VERSION},"daemonVersion":"1.2.3","agents":["claude"],"home":"/h"}\n`;

test("handshake: sends hello, requests snapshot after daemon hello", async () => {
  const h = harness();
  h.client.start();
  await tick(5);
  assert.deepEqual(h.sentToDaemon, [`{"type":"hello","protocol":${PROTOCOL_VERSION}}`]);
  h.fromDaemon.write(hello);
  await tick(5);
  assert.deepEqual(h.calls, ["hello:1.2.3"]);
  assert.equal(h.sentToDaemon[1], '{"type":"snapshot"}');
  h.fromDaemon.write('{"type":"snapshot","sessions":[]}\n{"type":"changed","upserted":[],"removed":["a:b"]}\n');
  await tick(5);
  assert.deepEqual(h.calls.slice(1), ["snapshot:0", "changed:0:1"]);
  h.client.dispose();
});

test("pings after hello and fails on missing pong", async () => {
  const h = harness();
  h.client.start();
  h.fromDaemon.write(hello);
  await tick(30);
  assert.ok(h.sentToDaemon.includes('{"type":"ping"}'));
  await tick(50);
  assert.ok(h.calls.some((c) => c.startsWith("error:pong timeout")));
  assert.equal(h.calls.at(-1), "close");
});

test("pong keeps the connection alive", async () => {
  const h = harness();
  h.client.start();
  h.fromDaemon.write(hello);
  const pumper = setInterval(() => h.fromDaemon.write('{"type":"pong"}\n'), 10);
  await tick(120);
  clearInterval(pumper);
  assert.ok(!h.calls.some((c) => c.startsWith("error")));
  h.client.dispose();
});

test("hello timeout and daemon error are reported", async () => {
  const h = harness();
  h.client.start();
  await tick(70);
  assert.ok(h.calls.some((c) => c === "error:hello timeout"));
  const h2 = harness();
  h2.client.start();
  h2.fromDaemon.write('{"type":"error","message":"unsupported protocol"}\n');
  await tick(5);
  assert.equal(h2.calls[0], "error:unsupported protocol");
  h2.client.dispose();
});

test("stream close fires onClose once", async () => {
  const h = harness();
  h.client.start();
  h.fromDaemon.end();
  await tick(5);
  h.client.dispose();
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
});

test("output stream error is reported and closes once", async () => {
  const h = harness();
  h.client.start();
  h.toDaemon.emit("error", new Error("EPIPE"));
  await tick(5);
  assert.ok(h.calls.some((c) => c.startsWith("error:output stream error")));
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
});

test("dispose while the stream is alive closes the readline and stops pings", async () => {
  const h = harness();
  h.client.start();
  h.fromDaemon.write(hello);
  await tick(5);
  h.client.dispose();
  const sentCount = h.sentToDaemon.length;
  await tick(60);
  assert.equal(h.sentToDaemon.length, sentCount);
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  const callsCount = h.calls.length;
  h.fromDaemon.write('{"type":"snapshot","sessions":[]}\n');
  await tick(5);
  assert.equal(h.calls.length, callsCount);
});

test("an unparsable line is a warning and does not close the connection", async () => {
  const h = harness({ pingIntervalMs: 1000, pongTimeoutMs: 1000 });
  h.client.start();
  h.fromDaemon.write("Welcome to my shell\n" + hello + "not json\n");
  await tick(5);
  h.fromDaemon.write('{"type":"snapshot","sessions":[]}\n');
  await tick(5);
  assert.deepEqual(h.calls, ["warning:ignoring unparsable line: Welcome to my shell", "hello:1.2.3", "warning:ignoring unparsable line: not json", "snapshot:0"]);
  h.client.dispose();
});

test("sendShutdown writes a shutdown message to the daemon", async () => {
  const h = harness();
  h.client.sendShutdown();
  await tick(5);
  assert.deepEqual(h.sentToDaemon, ['{"type":"shutdown"}']);
  h.client.dispose();
});

function connected(opts = {}) {
  const h = harness({ pingIntervalMs: 1000, pongTimeoutMs: 1000, ...opts });
  h.client.start();
  h.fromDaemon.write(hello);
  return h;
}
const sentDeletes = (h: ReturnType<typeof harness>) => h.sentToDaemon.map((l) => JSON.parse(l)).filter((m) => m.type === "delete");

test("deleteSession sends a delete request and resolves on ok", async () => {
  const h = connected();
  await tick(5);
  const done = h.client.deleteSession("codex", "u1");
  await tick(5);
  const [req] = sentDeletes(h);
  assert.deepEqual({ ...req, requestId: typeof req.requestId }, { type: "delete", requestId: "string", agent: "codex", id: "u1" });
  // An unknown request id is ignored.
  h.fromDaemon.write(JSON.stringify({ type: "deleteResult", requestId: "nope", ok: false, error: "x" }) + "\n");
  h.fromDaemon.write(JSON.stringify({ type: "deleteResult", requestId: req.requestId, ok: true }) + "\n");
  await done;
  h.client.dispose();
});

test("deleteSession matches answers by request id and rejects with the daemon's error", async () => {
  const h = connected();
  await tick(5);
  const first = h.client.deleteSession("codex", "u1");
  const second = h.client.deleteSession("claude", "c1");
  await tick(5);
  const [r1, r2] = sentDeletes(h);
  assert.notEqual(r1.requestId, r2.requestId);
  h.fromDaemon.write(JSON.stringify({ type: "deleteResult", requestId: r2.requestId, ok: false, error: "the session is running" }) + "\n");
  await assert.rejects(second, /the session is running/);
  h.fromDaemon.write(JSON.stringify({ type: "deleteResult", requestId: r1.requestId, ok: true }) + "\n");
  await first;
  // ok:false without a message still rejects.
  const third = h.client.deleteSession("codex", "u2");
  await tick(5);
  h.fromDaemon.write(JSON.stringify({ type: "deleteResult", requestId: sentDeletes(h)[2].requestId, ok: false }) + "\n");
  await assert.rejects(third, /delete failed/);
  h.client.dispose();
});

test("deleteSession rejects on timeout, on close and when already closed", async () => {
  const h = connected({ requestTimeoutMs: 20 });
  await tick(5);
  await assert.rejects(h.client.deleteSession("codex", "u1"), /no answer within 0 s; the deletion may still complete/);
  const pending = h.client.deleteSession("codex", "u2");
  h.fromDaemon.end();
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(h.client.deleteSession("codex", "u3"), /not connected/);
});

test("pendingOpen sends the session and settles on the result", async () => {
  const h = harness();
  h.client.start();
  const session = { agent: "claude" as const, id: "a", title: "a", cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle" as const };
  const done = h.client.pendingOpen(session);
  await tick(5);
  const req = JSON.parse(h.sentToDaemon.find((l) => l.includes('"pendingOpen"'))!);
  assert.deepEqual(req.session, session);
  h.fromDaemon.write(JSON.stringify({ type: "pendingOpenResult", requestId: req.requestId, ok: false, error: "/w does not exist" }) + "\n");
  await assert.rejects(done, /\/w does not exist/);
  const ok = h.client.pendingOpen(session);
  await tick(5);
  const req2 = JSON.parse(h.sentToDaemon.find((l) => l.includes('"pendingOpen"') && !l.includes(`"requestId":"${req.requestId}"`))!);
  h.fromDaemon.write(JSON.stringify({ type: "pendingOpenResult", requestId: req2.requestId, ok: true }) + "\n");
  await ok;
  h.client.dispose();
});

test("renameSession sends a rename request and settles on the result", async () => {
  const h = connected();
  await tick(5);
  const sentRenames = () => h.sentToDaemon.map((l) => JSON.parse(l)).filter((m) => m.type === "rename");
  const done = h.client.renameSession("codex", "u1", "New name");
  await tick(5);
  const [req] = sentRenames();
  assert.deepEqual({ ...req, requestId: typeof req.requestId }, { type: "rename", requestId: "string", agent: "codex", id: "u1", title: "New name" });
  h.fromDaemon.write(JSON.stringify({ type: "renameResult", requestId: req.requestId, ok: true }) + "\n");
  await done;
  const refused = h.client.renameSession("claude", "c1", "Other");
  await tick(5);
  h.fromDaemon.write(JSON.stringify({ type: "renameResult", requestId: sentRenames()[1].requestId, ok: false, error: "no rollout found" }) + "\n");
  await assert.rejects(refused, /no rollout found/);
  // ok:false without a message still rejects.
  const bare = h.client.renameSession("codex", "u2", "x");
  await tick(5);
  h.fromDaemon.write(JSON.stringify({ type: "renameResult", requestId: sentRenames()[2].requestId, ok: false }) + "\n");
  await assert.rejects(bare, /rename failed/);
  h.client.dispose();
});

test("renameSession rejects on timeout and when closed", async () => {
  const h = connected({ requestTimeoutMs: 20 });
  await tick(5);
  await assert.rejects(h.client.renameSession("codex", "u1", "x"), /no answer within 0 s; the rename may still complete/);
  h.fromDaemon.end();
  await tick(5);
  await assert.rejects(h.client.renameSession("codex", "u3", "x"), /not connected/);
});

test("moveSession sends a move request and settles on the result", async () => {
  const h = connected();
  await tick(5);
  const sentMoves = () => h.sentToDaemon.map((l) => JSON.parse(l)).filter((m) => m.type === "move");
  const done = h.client.moveSession("claude", "c1", "/z");
  await tick(5);
  const req = sentMoves()[0];
  assert.deepEqual({ ...req, requestId: typeof req.requestId }, { type: "move", requestId: "string", agent: "claude", id: "c1", cwd: "/z" });
  h.fromDaemon.write(JSON.stringify({ type: "moveResult", requestId: req.requestId, ok: true }) + "\n");
  await done;
  const refused = h.client.moveSession("claude", "c2", "/z");
  await tick(5);
  h.fromDaemon.write(JSON.stringify({ type: "moveResult", requestId: sentMoves()[1].requestId, ok: false, error: "open in Claude Code" }) + "\n");
  await assert.rejects(refused, /open in Claude Code/);
  const bare = h.client.moveSession("claude", "c3", "/z");
  await tick(5);
  h.fromDaemon.write(JSON.stringify({ type: "moveResult", requestId: sentMoves()[2].requestId, ok: false }) + "\n");
  await assert.rejects(bare, /move failed/);
  h.client.dispose();
});
