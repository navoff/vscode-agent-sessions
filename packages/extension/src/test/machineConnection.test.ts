import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { SessionInfo } from "@agent-sessions/core";
import { MachineConnection, createStderrTail, type DaemonProcess, type MachineState } from "../connection/machineConnection.js";

const hello = '{"type":"hello","protocol":1,"daemonVersion":"9","agents":["claude"],"home":"/h"}\n';
const s = (id: string): SessionInfo => ({ agent: "claude", id, title: id, cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle" });

class FakeProc implements DaemonProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  private exitCb: ((code: number | null) => void) | undefined;
  received: string[] = [];
  constructor() {
    this.stdin.on("data", (d) => this.received.push(...String(d).trim().split("\n")));
  }
  kill() { this.killed = true; }
  onExit(cb: (code: number | null) => void) { this.exitCb = cb; }
  exit(code: number) { this.exitCb?.(code); }
}

function harness(autoReconnect = true) {
  const procs: FakeProc[] = [];
  const states: MachineState[] = [];
  let sessions = new Map<string, SessionInfo>();
  const conn = new MachineConnection("m1", () => { const p = new FakeProc(); procs.push(p); return p; },
    { onStateChange: (st) => states.push(st), onSessions: (m) => { sessions = m; } },
    { autoReconnect, backoffMs: [10, 10], clientOptions: { pingIntervalMs: 1000, pongTimeoutMs: 1000, helloTimeoutMs: 1000 } });
  return { procs, states, conn, getSessions: () => sessions };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("connect reaches connected and applies snapshot and changes", async () => {
  const h = harness();
  h.conn.connect();
  await tick(5);
  assert.deepEqual(h.states, ["connecting"]);
  h.procs[0].stdout.write(hello + JSON.stringify({ type: "snapshot", sessions: [s("a"), s("b")] }) + "\n");
  await tick(5);
  assert.equal(h.conn.state, "connected");
  assert.equal(h.conn.daemonVersion, "9");
  assert.deepEqual([...h.getSessions().keys()], ["claude:a", "claude:b"]);
  h.procs[0].stdout.write(JSON.stringify({ type: "changed", upserted: [s("c")], removed: ["claude:a"] }) + "\n");
  await tick(5);
  assert.deepEqual([...h.getSessions().keys()].sort(), ["claude:b", "claude:c"]);
  h.conn.dispose();
});

test("process exit triggers error state and reconnect with backoff", async () => {
  const h = harness();
  h.conn.connect();
  await tick(5);
  h.procs[0].exit(1);
  await tick(5);
  assert.equal(h.conn.state, "error");
  assert.equal(h.conn.error, "daemon exited with code 1");
  await tick(30);
  assert.equal(h.procs.length, 2);
  assert.equal(h.conn.state, "connecting");
  h.conn.dispose();
});

test("no reconnect when autoReconnect is off, disconnect kills the process", async () => {
  const h = harness(false);
  h.conn.connect();
  await tick(5);
  h.procs[0].exit(1);
  await tick(40);
  assert.equal(h.procs.length, 1);
  assert.equal(h.conn.state, "error");
  h.conn.connect();
  await tick(5);
  h.conn.disconnect();
  assert.ok(h.procs[1].killed);
  assert.equal(h.conn.state, "disconnected");
  assert.equal(h.getSessions().size, 0);
});

test("factory failure is reported as error", async () => {
  const states: MachineState[] = [];
  const conn = new MachineConnection("m", () => { throw new Error("no ssh"); }, { onStateChange: (st) => states.push(st), onSessions: () => {} }, { autoReconnect: false });
  conn.connect();
  await tick(5);
  assert.equal(conn.state, "error");
  assert.match(conn.error ?? "", /no ssh/);
});

test("exit error includes the last stderr lines of the process", async () => {
  const procs: FakeProc[] = [];
  const conn = new MachineConnection("m1", () => {
    const p = new FakeProc();
    (p as DaemonProcess).lastStderr = () => "Permission denied (publickey)";
    procs.push(p);
    return p;
  }, { onStateChange: () => {}, onSessions: () => {} }, { autoReconnect: false, clientOptions: { pingIntervalMs: 1000, pongTimeoutMs: 1000, helloTimeoutMs: 1000 } });
  conn.connect();
  await tick(5);
  procs[0].exit(255);
  await tick(5);
  assert.equal(conn.state, "error");
  assert.equal(conn.error, "daemon exited with code 255: Permission denied (publickey)");
  conn.dispose();
});

test("createStderrTail keeps the last five lines", () => {
  const t = createStderrTail();
  t.push("one\ntwo\n");
  t.push("\nthree\nfour\nfi");
  t.push("ve\nsix\nseven");
  assert.equal(t.text(), "three | four | five | six | seven");
});

test("an async factory reaches connected", async () => {
  const procs: FakeProc[] = [];
  const conn = new MachineConnection("m", async () => { const p = new FakeProc(); procs.push(p); return p; },
    { onStateChange: () => {}, onSessions: () => {} },
    { autoReconnect: false, clientOptions: { pingIntervalMs: 1000, pongTimeoutMs: 1000, helloTimeoutMs: 1000 } });
  conn.connect();
  await tick(10);
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].received, ['{"type":"hello","protocol":1}']);
  procs[0].stdout.write(hello);
  await tick(10);
  assert.equal(conn.state, "connected");
  conn.requestShutdown();
  await tick(5);
  assert.equal(procs[0].received.at(-1), '{"type":"shutdown"}');
  conn.dispose();
});

test("a rejecting async factory is reported as error", async () => {
  const conn = new MachineConnection("m", async () => { throw new Error("socket gone"); },
    { onStateChange: () => {}, onSessions: () => {} }, { autoReconnect: false });
  conn.connect();
  await tick(10);
  assert.equal(conn.state, "error");
  assert.equal(conn.error, "socket gone");
});

test("disconnect before an async factory resolves kills the late process", async () => {
  let resolve: ((p: FakeProc) => void) | undefined;
  const conn = new MachineConnection("m", () => new Promise<DaemonProcess>((r) => { resolve = r; }),
    { onStateChange: () => {}, onSessions: () => {} }, { autoReconnect: false });
  conn.connect();
  await tick(5);
  conn.disconnect();
  const p = new FakeProc();
  resolve?.(p);
  await tick(5);
  assert.ok(p.killed);
  assert.equal(conn.state, "disconnected");
});
