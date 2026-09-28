import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo, SessionProvider } from "@agent-sessions/core";
import { Daemon, sameSession } from "../daemon.js";
import { parseClientMessage, parseDaemonMessage, PROTOCOL_VERSION, type DaemonMessage } from "../protocol.js";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const s = (agent: "claude" | "codex", id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  agent, id, title: id, cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle", ...over,
});

function setup(opts: { debounceMs?: number; pollMs?: number } = {}) {
  const sent: DaemonMessage[] = [];
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const daemon = new Daemon({ providers: [claude, codex], send: (m) => sent.push(m), version: "t", home: "/h", debounceMs: opts.debounceMs ?? 10, pollMs: opts.pollMs ?? 60_000 });
  return { sent, claude, codex, daemon };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("parseClientMessage accepts known messages only", () => {
  assert.deepEqual(parseClientMessage('{"type":"ping"}'), { type: "ping" });
  assert.deepEqual(parseClientMessage('{"type":"hello","protocol":1}'), { type: "hello", protocol: 1 });
  assert.equal(parseClientMessage('{"type":"nope"}'), undefined);
  assert.equal(parseClientMessage("bad"), undefined);
});

test("hello with wrong protocol yields error", () => {
  const { sent, daemon } = setup();
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION + 1 });
  assert.equal(sent[0].type, "error");
  daemon.stop();
});

test("hello then snapshot returns full list", async () => {
  const { sent, claude, daemon } = setup();
  claude.sessions = [s("claude", "a")];
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  assert.deepEqual(sent[0], { type: "hello", protocol: 1, daemonVersion: "t", agents: ["claude", "codex"], home: "/h" });
  daemon.handle({ type: "snapshot" });
  await tick(30);
  assert.equal(sent[1].type, "snapshot");
  assert.deepEqual((sent[1] as { sessions: SessionInfo[] }).sessions.map((x) => x.id), ["a"]);
  daemon.handle({ type: "ping" });
  assert.equal(sent[2].type, "pong");
  daemon.stop();
});

test("provider change emits a debounced diff", async () => {
  const { sent, claude, codex, daemon } = setup();
  claude.sessions = [s("claude", "a"), s("claude", "b")];
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  daemon.handle({ type: "snapshot" });
  await tick(30);
  claude.sessions = [s("claude", "a", { status: "running" })];
  codex.sessions = [s("codex", "c")];
  claude.trigger();
  claude.trigger();
  codex.trigger();
  await tick(60);
  const changed = sent.filter((m) => m.type === "changed");
  assert.equal(changed.length, 1);
  const c = changed[0] as { upserted: SessionInfo[]; removed: string[] };
  assert.deepEqual(c.upserted.map((x) => `${x.agent}:${x.id}`).sort(), ["claude:a", "codex:c"]);
  assert.deepEqual(c.removed, ["claude:b"]);
  daemon.stop();
});

test("a failing provider keeps its previous sessions", async () => {
  const { sent, claude, daemon } = setup();
  claude.sessions = [s("claude", "a")];
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  daemon.handle({ type: "snapshot" });
  await tick(30);
  claude.fail = true;
  claude.trigger();
  await tick(60);
  assert.equal(sent.filter((m) => m.type === "changed").length, 0);
  daemon.stop();
});

test("poll refreshes without watch events", async () => {
  const { sent, claude, daemon } = setup({ pollMs: 20 });
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  daemon.handle({ type: "snapshot" });
  await tick(30);
  claude.sessions = [s("claude", "z")];
  await tick(80);
  assert.ok(sent.some((m) => m.type === "changed"));
  daemon.stop();
});

test("snapshot requested during an in-flight refresh still gets a snapshot reply", async () => {
  const { sent, claude, daemon } = setup();
  const gate = deferred();
  claude.gate = gate.promise;
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  daemon.handle({ type: "snapshot" });
  daemon.handle({ type: "snapshot" });
  gate.resolve();
  await tick(30);
  assert.equal(sent.filter((m) => m.type === "snapshot").length, 2);
  daemon.stop();
});

test("stop during an in-flight refresh sends nothing and runs no further snapshots", async () => {
  const { sent, claude, daemon } = setup();
  const gate = deferred();
  claude.gate = gate.promise;
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  daemon.handle({ type: "snapshot" });
  daemon.stop();
  gate.resolve();
  await tick(30);
  assert.equal(sent.filter((m) => m.type === "snapshot" || m.type === "changed").length, 0);
  assert.equal(claude.snapshotCalls, 1);
  const before = sent.length;
  daemon.handle({ type: "ping" });
  assert.equal(sent.length, before);
});

test("drain waits for the in-flight and queued full refresh", async () => {
  const { sent, claude, daemon } = setup();
  const gate = deferred();
  claude.gate = gate.promise;
  daemon.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  daemon.handle({ type: "snapshot" });
  daemon.handle({ type: "snapshot" });
  const d = daemon.drain();
  await tick(10);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "hello");
  gate.resolve();
  await d;
  assert.equal(sent.filter((m) => m.type === "snapshot").length, 2);
  await daemon.drain();
  daemon.stop();
});

test("sameSession compares the fields that matter", () => {
  assert.ok(sameSession(s("claude", "a"), s("claude", "a")));
  assert.ok(!sameSession(s("claude", "a"), s("claude", "a", { status: "running" })));
  assert.ok(!sameSession(s("claude", "a"), s("claude", "a", { live: { pid: 1, statusUpdatedAt: 2 } })));
});

test("parseDaemonMessage drops malformed sessions and removed keys", () => {
  const good: SessionInfo = { agent: "claude", id: "a", title: "t", cwd: "/w", createdAt: 1, updatedAt: 2, status: "idle" };
  const bad = { ...good, id: 5, status: "weird" };
  assert.deepEqual(parseDaemonMessage(JSON.stringify({ type: "snapshot", sessions: [null, bad, good] })), { type: "snapshot", sessions: [good] });
  assert.deepEqual(parseDaemonMessage(JSON.stringify({ type: "changed", upserted: [good, { ...good, updatedAt: "2" }], removed: ["claude:a", null, 3] })), {
    type: "changed",
    upserted: [good],
    removed: ["claude:a"],
  });
});
