import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
const hello = '{"type":"hello","protocol":1,"daemonVersion":"1.2.3","agents":["claude"],"home":"/h"}\n';

test("handshake: sends hello, requests snapshot after daemon hello", async () => {
  const h = harness();
  h.client.start();
  await tick(5);
  assert.deepEqual(h.sentToDaemon, ['{"type":"hello","protocol":1}']);
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
