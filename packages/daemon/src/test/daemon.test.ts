import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo, SessionProvider } from "@agent-sessions/core";
import { Daemon, sameSession } from "../daemon.js";
import { parseClientMessage, PROTOCOL_VERSION, type DaemonMessage } from "../protocol.js";

class FakeProvider implements SessionProvider {
  sessions: SessionInfo[] = [];
  fail = false;
  gate: Promise<void> | undefined;
  snapshotCalls = 0;
  private cb: (() => void) | undefined;
  constructor(readonly agent: "claude" | "codex") {}
  async snapshot(): Promise<SessionInfo[]> {
    this.snapshotCalls++;
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("provider down");
    return this.sessions;
  }
  watch(onChange: () => void) {
    this.cb = onChange;
    return { dispose: () => { this.cb = undefined; } };
  }
  trigger() { this.cb?.(); }
}

const s = (agent: "claude" | "codex", id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  agent, id, title: id, cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle", ...over,
});
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(opts: { debounceMs?: number; pollMs?: number } = {}) {
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const idle: number[] = [];
  let stopped = 0;
  const daemon = new Daemon({
    providers: [claude, codex], version: "t", home: "/h",
    debounceMs: opts.debounceMs ?? 10, pollMs: opts.pollMs ?? 60_000,
    onIdle: () => idle.push(Date.now()), onStop: () => { stopped++; },
  });
  const attach = () => {
    const sent: DaemonMessage[] = [];
    const client = daemon.attach((m) => sent.push(m));
    return { sent, client };
  };
  return { claude, codex, daemon, attach, idle, stopped: () => stopped };
}

test("parseClientMessage accepts shutdown", () => {
  assert.deepEqual(parseClientMessage('{"type":"shutdown"}'), { type: "shutdown" });
  assert.deepEqual(parseClientMessage('{"type":"ping"}'), { type: "ping" });
  assert.equal(parseClientMessage('{"type":"nope"}'), undefined);
});

test("hello with wrong protocol detaches only that client", () => {
  const h = setup();
  const a = h.attach();
  const b = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION + 1 });
  assert.equal(a.sent[0].type, "error");
  assert.ok(a.client.detached);
  assert.equal(h.daemon.clientCount, 1);
  b.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  assert.equal(b.sent[0].type, "hello");
  assert.equal(h.stopped(), 0);
  h.daemon.stop();
});

test("each client gets its own hello, snapshot and pong", async () => {
  const h = setup();
  h.claude.sessions = [s("claude", "a")];
  const a = h.attach();
  const b = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "snapshot" });
  await tick(30);
  assert.deepEqual(a.sent.map((m) => m.type), ["hello", "snapshot"]);
  assert.deepEqual(b.sent, [] as DaemonMessage[]);
  b.client.handle({ type: "ping" });
  assert.deepEqual(b.sent.map((m) => m.type), ["pong"]);
  h.daemon.stop();
});

test("a full snapshot for one client sends changed to synced clients", async () => {
  const h = setup();
  h.claude.sessions = [s("claude", "a")];
  const a = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "snapshot" });
  await tick(30);
  h.claude.sessions = [s("claude", "a", { status: "running" }), s("claude", "b")];
  const b = h.attach();
  b.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  b.client.handle({ type: "snapshot" });
  await tick(30);
  const bSnap = b.sent.find((m) => m.type === "snapshot") as { sessions: SessionInfo[] };
  assert.deepEqual(bSnap.sessions.map((x) => x.id).sort(), ["a", "b"]);
  const aChanged = a.sent.filter((m) => m.type === "changed") as Array<{ upserted: SessionInfo[]; removed: string[] }>;
  assert.equal(aChanged.length, 1);
  assert.deepEqual(aChanged[0].upserted.map((x) => x.id).sort(), ["a", "b"]);
  assert.deepEqual(aChanged[0].removed, []);
  h.daemon.stop();
});

test("provider change emits one debounced diff to all synced clients only", async () => {
  const h = setup();
  h.claude.sessions = [s("claude", "a"), s("claude", "b")];
  const a = h.attach();
  const b = h.attach();
  const c = h.attach();
  for (const x of [a, b]) { x.client.handle({ type: "hello", protocol: PROTOCOL_VERSION }); x.client.handle({ type: "snapshot" }); }
  c.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  await tick(30);
  h.claude.sessions = [s("claude", "a", { status: "running" })];
  h.codex.sessions = [s("codex", "c")];
  h.claude.trigger();
  h.claude.trigger();
  h.codex.trigger();
  await tick(60);
  for (const x of [a, b]) {
    const changed = x.sent.filter((m) => m.type === "changed") as Array<{ upserted: SessionInfo[]; removed: string[] }>;
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0].upserted.map((m) => `${m.agent}:${m.id}`).sort(), ["claude:a", "codex:c"]);
    assert.deepEqual(changed[0].removed, ["claude:b"]);
  }
  assert.equal(c.sent.filter((m) => m.type === "changed").length, 0);
  h.daemon.stop();
});

test("a failing provider keeps its previous sessions", async () => {
  const h = setup();
  h.claude.sessions = [s("claude", "a")];
  const a = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "snapshot" });
  await tick(30);
  h.claude.fail = true;
  h.claude.trigger();
  await tick(60);
  assert.equal(a.sent.filter((m) => m.type === "changed").length, 0);
  h.daemon.stop();
});

test("poll refreshes without watch events", async () => {
  const h = setup({ pollMs: 20 });
  const a = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "snapshot" });
  await tick(30);
  h.claude.sessions = [s("claude", "z")];
  await tick(80);
  assert.ok(a.sent.some((m) => m.type === "changed"));
  h.daemon.stop();
});

test("snapshot requested during an in-flight refresh still gets a snapshot reply", async () => {
  const h = setup();
  const gate = deferred();
  h.claude.gate = gate.promise;
  const a = h.attach();
  const b = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  b.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "snapshot" });
  b.client.handle({ type: "snapshot" });
  gate.resolve();
  await tick(30);
  assert.equal(a.sent.filter((m) => m.type === "snapshot").length, 1);
  assert.equal(b.sent.filter((m) => m.type === "snapshot").length, 1);
  h.daemon.stop();
});

test("drain waits for the in-flight and queued full refresh", async () => {
  const h = setup();
  const gate = deferred();
  h.claude.gate = gate.promise;
  const a = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "snapshot" });
  a.client.handle({ type: "snapshot" });
  const d = h.daemon.drain();
  assert.equal(a.sent.length, 1);
  gate.resolve();
  await d;
  assert.equal(a.sent.filter((m) => m.type === "snapshot").length, 1);
  await h.daemon.drain();
  h.daemon.stop();
});

test("shutdown stops the engine, detaches everyone and calls onStop once", async () => {
  const h = setup();
  const a = h.attach();
  const b = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  b.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "shutdown" });
  assert.ok(a.client.detached && b.client.detached);
  assert.equal(h.daemon.clientCount, 0);
  assert.equal(h.stopped(), 1);
  b.client.handle({ type: "ping" });
  assert.equal(b.sent.filter((m) => m.type === "pong").length, 0);
  h.daemon.stop();
  assert.equal(h.stopped(), 1);
});

test("detaching the last client calls onIdle, detach is idempotent", () => {
  const h = setup();
  const a = h.attach();
  const b = h.attach();
  a.client.detach();
  assert.equal(h.idle.length, 0);
  b.client.detach();
  b.client.detach();
  assert.equal(h.idle.length, 1);
  assert.equal(h.daemon.clientCount, 0);
  h.daemon.stop();
});

test("stop during an in-flight refresh sends nothing afterwards", async () => {
  const h = setup();
  const gate = deferred();
  h.claude.gate = gate.promise;
  const a = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "snapshot" });
  h.daemon.stop();
  gate.resolve();
  await tick(30);
  assert.equal(a.sent.filter((m) => m.type !== "hello").length, 0);
  assert.equal(h.claude.snapshotCalls, 1);
});

test("sameSession compares the fields that matter", () => {
  assert.ok(sameSession(s("claude", "a"), s("claude", "a")));
  assert.ok(!sameSession(s("claude", "a"), s("claude", "a", { status: "running" })));
});
