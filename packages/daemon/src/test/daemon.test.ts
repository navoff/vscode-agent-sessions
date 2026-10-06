import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPendingOpen } from "../pendingOpen.js";
import type { SessionInfo, SessionProvider } from "@agent-sessions/core";
import { Daemon, sameSession } from "../daemon.js";
import { parseClientMessage, parseDaemonMessage, PROTOCOL_VERSION, type DaemonMessage } from "../protocol.js";

class FakeProvider implements SessionProvider {
  sessions: SessionInfo[] = [];
  fail = false;
  gate: Promise<void> | undefined;
  snapshotCalls = 0;
  deleted: string[] = [];
  deleteError: Error | undefined;
  renamed: Array<[string, string]> = [];
  renameError: Error | undefined;
  moved: Array<[string, string]> = [];
  moveError: Error | undefined;
  private cb: (() => void) | undefined;
  constructor(readonly agent: "claude" | "codex") {}
  async delete(id: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(id);
    this.sessions = this.sessions.filter((x) => x.id !== id);
  }
  async rename(id: string, title: string): Promise<void> {
    if (this.renameError) throw this.renameError;
    this.renamed.push([id, title]);
    this.sessions = this.sessions.map((x) => (x.id === id ? { ...x, title } : x));
  }
  async move(id: string, cwd: string): Promise<void> {
    if (this.moveError) throw this.moveError;
    this.moved.push([id, cwd]);
    this.sessions = this.sessions.map((x) => (x.id === id ? { ...x, cwd } : x));
  }
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

function setup(opts: { debounceMs?: number; pollMs?: number; home?: string } = {}) {
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const idle: number[] = [];
  let stopped = 0;
  const daemon = new Daemon({
    providers: [claude, codex], version: "t", home: opts.home ?? "/h",
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

test("parse rename and renameResult messages", () => {
  assert.deepEqual(parseClientMessage('{"type":"rename","requestId":"7","agent":"codex","id":"u1","title":"New name"}'), { type: "rename", requestId: "7", agent: "codex", id: "u1", title: "New name" });
  assert.equal(parseClientMessage('{"type":"rename","requestId":"7","agent":"codex","id":"u1"}'), undefined);
  assert.equal(parseClientMessage('{"type":"rename","requestId":"7","agent":"codex","id":"u1","title":5}'), undefined);
  assert.equal(parseClientMessage('{"type":"rename","agent":"codex","id":"u1","title":"x"}'), undefined);
  assert.deepEqual(parseDaemonMessage('{"type":"renameResult","requestId":"7","ok":true}'), { type: "renameResult", requestId: "7", ok: true });
  assert.deepEqual(parseDaemonMessage('{"type":"renameResult","requestId":"7","ok":false,"error":"no"}'), { type: "renameResult", requestId: "7", ok: false, error: "no" });
  assert.equal(parseDaemonMessage('{"type":"renameResult","requestId":"7"}'), undefined);
  assert.equal(parseDaemonMessage('{"type":"renameResult","ok":true}'), undefined);
});

test("parse delete and deleteResult messages", () => {
  assert.deepEqual(parseClientMessage('{"type":"delete","requestId":"7","agent":"codex","id":"u1"}'), { type: "delete", requestId: "7", agent: "codex", id: "u1" });
  assert.equal(parseClientMessage('{"type":"delete","agent":"codex","id":"u1"}'), undefined);
  assert.equal(parseClientMessage('{"type":"delete","requestId":7,"agent":"codex","id":"u1"}'), undefined);
  assert.equal(parseClientMessage('{"type":"delete","requestId":"7","agent":"codex"}'), undefined);
  assert.deepEqual(parseDaemonMessage('{"type":"deleteResult","requestId":"7","ok":true}'), { type: "deleteResult", requestId: "7", ok: true });
  assert.deepEqual(parseDaemonMessage('{"type":"deleteResult","requestId":"7","ok":false,"error":"no"}'), { type: "deleteResult", requestId: "7", ok: false, error: "no" });
  assert.equal(parseDaemonMessage('{"type":"deleteResult","requestId":"7"}'), undefined);
  assert.equal(parseDaemonMessage('{"type":"deleteResult","ok":true}'), undefined);
});

test("parse pendingOpen and pendingOpenResult messages", () => {
  const good = s("claude", "a");
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "pendingOpen", requestId: "9", session: good })), { type: "pendingOpen", requestId: "9", session: good });
  // A request for a new session has no id, see newSessionRequest in the extension.
  const fresh = s("codex", "");
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "pendingOpen", requestId: "9", session: fresh })), { type: "pendingOpen", requestId: "9", session: fresh });
  assert.equal(parseClientMessage(JSON.stringify({ type: "pendingOpen", session: good })), undefined);
  assert.equal(parseClientMessage(JSON.stringify({ type: "pendingOpen", requestId: "9", session: { id: "a" } })), undefined);
  assert.deepEqual(parseDaemonMessage('{"type":"pendingOpenResult","requestId":"9","ok":true}'), { type: "pendingOpenResult", requestId: "9", ok: true });
  assert.deepEqual(parseDaemonMessage('{"type":"pendingOpenResult","requestId":"9","ok":false,"error":"no"}'), { type: "pendingOpenResult", requestId: "9", ok: false, error: "no" });
  assert.equal(parseDaemonMessage('{"type":"pendingOpenResult","ok":true}'), undefined);
});

test("pendingOpen writes the file under home and answers the requester", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-daemon-home-"));
  const h = setup({ home });
  const a = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  const session = s("claude", "a", { cwd: home });
  a.client.handle({ type: "pendingOpen", requestId: "1", session });
  await tick(20);
  assert.deepEqual(a.sent.at(-1), { type: "pendingOpenResult", requestId: "1", ok: true });
  assert.deepEqual((await readPendingOpen(home))?.session, session);
  h.daemon.stop();
});

test("pendingOpen reports a missing folder and needs the handshake", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-daemon-home-"));
  const h = setup({ home });
  const a = h.attach();
  a.client.handle({ type: "pendingOpen", requestId: "1", session: s("claude", "a", { cwd: home }) });
  assert.deepEqual(a.sent.at(-1), { type: "pendingOpenResult", requestId: "1", ok: false, error: "handshake required" });
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "pendingOpen", requestId: "2", session: s("claude", "a", { cwd: join(home, "gone") }) });
  await tick(20);
  assert.deepEqual(a.sent.at(-1), { type: "pendingOpenResult", requestId: "2", ok: false, error: `${join(home, "gone")} does not exist` });
  h.daemon.stop();
});

test("parseClientMessage reads hello with protocol and rejects non-JSON", () => {
  assert.deepEqual(parseClientMessage('{"type":"hello","protocol":1}'), { type: "hello", protocol: 1 });
  assert.equal(parseClientMessage('{"type":"hello"}'), undefined);
  assert.equal(parseClientMessage("not json"), undefined);
});

test("parseDaemonMessage drops malformed sessions and removed keys", () => {
  const good = s("claude", "a");
  const snap = parseDaemonMessage(JSON.stringify({ type: "snapshot", sessions: [good, null, { agent: "claude", id: 5 }] }));
  assert.deepEqual(snap, { type: "snapshot", sessions: [good] });
  const changed = parseDaemonMessage(JSON.stringify({ type: "changed", upserted: [null, good], removed: ["claude:x", 3, null] }));
  assert.deepEqual(changed, { type: "changed", upserted: [good], removed: ["claude:x"] });
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
  assert.deepEqual(b.sent[0], { type: "hello", protocol: PROTOCOL_VERSION, daemonVersion: "t", agents: ["claude", "codex"], home: "/h" });
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
  assert.ok(!sameSession(s("claude", "a"), s("claude", "a", { firstPrompt: "p" })));
  const live = (pid: number, statusUpdatedAt: number) => s("claude", "a", { live: { pid, statusUpdatedAt } });
  assert.ok(sameSession(live(1, 10), live(1, 10)));
  assert.ok(!sameSession(live(1, 10), live(2, 10)));
  assert.ok(!sameSession(live(1, 10), live(1, 11)));
  assert.ok(!sameSession(s("claude", "a"), live(1, 10)));
});

test("a client whose send throws is detached, others still get the message", async () => {
  const h = setup();
  h.claude.sessions = [s("claude", "a")];
  const bad = h.daemon.attach((m) => { if (m.type === "changed") throw new Error("socket gone"); });
  const good = h.attach();
  bad.handle({ type: "snapshot" });
  good.client.handle({ type: "snapshot" });
  await tick(30);
  h.claude.sessions = [s("claude", "a", { status: "running" })];
  h.claude.trigger();
  await tick(60);
  assert.ok(bad.detached);
  assert.equal(h.daemon.clientCount, 1);
  assert.equal(good.sent.filter((m) => m.type === "changed").length, 1);
  h.daemon.stop();
});

async function syncedPair(h: ReturnType<typeof setup>) {
  const a = h.attach();
  const b = h.attach();
  for (const x of [a, b]) { x.client.handle({ type: "hello", protocol: PROTOCOL_VERSION }); x.client.handle({ type: "snapshot" }); }
  await tick(30);
  return { a, b };
}

test("delete answers only the requester, then every synced client gets the removal", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1"), s("codex", "u2")];
  const { a, b } = await syncedPair(h);
  const aBefore = a.sent.length;
  const bBefore = b.sent.length;
  a.client.handle({ type: "delete", requestId: "r1", agent: "codex", id: "u1" });
  await tick(30);
  assert.deepEqual(h.codex.deleted, ["u1"]);
  const aNew = a.sent.slice(aBefore);
  const bNew = b.sent.slice(bBefore);
  assert.deepEqual(aNew[0], { type: "deleteResult", requestId: "r1", ok: true });
  assert.ok(!bNew.some((m) => m.type === "deleteResult"));
  for (const msgs of [aNew, bNew]) {
    const changed = msgs.filter((m) => m.type === "changed") as Array<{ upserted: SessionInfo[]; removed: string[] }>;
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0], { type: "changed", upserted: [], removed: ["codex:u1"] });
  }
  h.daemon.stop();
});

test("a failed delete answers ok:false with the error and does not refresh", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1")];
  const { a, b } = await syncedPair(h);
  h.codex.deleteError = new Error("the session is running");
  const calls = h.codex.snapshotCalls;
  const aBefore = a.sent.length;
  const bBefore = b.sent.length;
  a.client.handle({ type: "delete", requestId: "r2", agent: "codex", id: "u1" });
  await tick(30);
  assert.deepEqual(a.sent.slice(aBefore), [{ type: "deleteResult", requestId: "r2", ok: false, error: "the session is running" }]);
  assert.equal(b.sent.length, bBefore);
  assert.equal(h.codex.snapshotCalls, calls);
  h.daemon.stop();
});

test("delete for an unknown agent or a provider without delete answers ok:false", async () => {
  const plain: SessionProvider = { agent: "claude", snapshot: async () => [], watch: () => ({ dispose: () => {} }) };
  const daemon = new Daemon({ providers: [plain], version: "t", home: "/h", debounceMs: 10, pollMs: 60_000 });
  const sent: DaemonMessage[] = [];
  const c = daemon.attach((m) => sent.push(m));
  c.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  sent.length = 0;
  c.handle({ type: "delete", requestId: "1", agent: "opencode", id: "x" });
  c.handle({ type: "delete", requestId: "2", agent: "claude", id: "x" });
  await tick(10);
  assert.deepEqual(sent, [
    { type: "deleteResult", requestId: "1", ok: false, error: 'unknown agent "opencode"' },
    { type: "deleteResult", requestId: "2", ok: false, error: "deleting claude sessions is not supported" },
  ]);
  daemon.stop();
});

test("delete before a completed hello answers handshake required and deletes nothing", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1")];
  const fresh = h.attach();
  fresh.client.handle({ type: "delete", requestId: "r0", agent: "codex", id: "u1" });
  const wrong = h.attach();
  wrong.client.handle({ type: "hello", protocol: PROTOCOL_VERSION + 1 });
  wrong.client.handle({ type: "delete", requestId: "r1", agent: "codex", id: "u1" });
  await tick(30);
  assert.deepEqual(fresh.sent, [{ type: "deleteResult", requestId: "r0", ok: false, error: "handshake required" }]);
  assert.ok(!wrong.sent.some((m) => m.type === "deleteResult"));
  assert.deepEqual(h.codex.deleted, []);
  h.daemon.stop();
});

test("a delete finishing after the requester detached sends it nothing", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1")];
  const { a, b } = await syncedPair(h);
  const gate = deferred();
  const orig = h.codex.delete.bind(h.codex);
  h.codex.delete = async (id: string) => { await gate.promise; return orig(id); };
  const aBefore = a.sent.length;
  a.client.handle({ type: "delete", requestId: "r3", agent: "codex", id: "u1" });
  a.client.detach();
  gate.resolve();
  await tick(30);
  assert.equal(a.sent.length, aBefore);
  assert.ok(b.sent.some((m) => m.type === "changed"));
  h.daemon.stop();
});

test("rename answers only the requester, then every synced client gets the new title", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1"), s("codex", "u2")];
  const { a, b } = await syncedPair(h);
  const aBefore = a.sent.length;
  const bBefore = b.sent.length;
  a.client.handle({ type: "rename", requestId: "r1", agent: "codex", id: "u1", title: "New name" });
  await tick(30);
  assert.deepEqual(h.codex.renamed, [["u1", "New name"]]);
  const aNew = a.sent.slice(aBefore);
  const bNew = b.sent.slice(bBefore);
  assert.deepEqual(aNew[0], { type: "renameResult", requestId: "r1", ok: true });
  assert.ok(!bNew.some((m) => m.type === "renameResult"));
  for (const msgs of [aNew, bNew]) {
    const changed = msgs.filter((m) => m.type === "changed");
    assert.deepEqual(changed, [{ type: "changed", upserted: [s("codex", "u1", { title: "New name" })], removed: [] }]);
  }
  h.daemon.stop();
});

test("a failed rename answers ok:false with the error and does not refresh", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1")];
  const { a, b } = await syncedPair(h);
  h.codex.renameError = new Error("no rollout found for thread id u1");
  const calls = h.codex.snapshotCalls;
  const aBefore = a.sent.length;
  const bBefore = b.sent.length;
  a.client.handle({ type: "rename", requestId: "r2", agent: "codex", id: "u1", title: "New name" });
  await tick(30);
  assert.deepEqual(a.sent.slice(aBefore), [{ type: "renameResult", requestId: "r2", ok: false, error: "no rollout found for thread id u1" }]);
  assert.equal(b.sent.length, bBefore);
  assert.equal(h.codex.snapshotCalls, calls);
  h.daemon.stop();
});

test("rename for an unknown agent or a provider without rename answers ok:false", async () => {
  const plain: SessionProvider = { agent: "claude", snapshot: async () => [], watch: () => ({ dispose: () => {} }) };
  const daemon = new Daemon({ providers: [plain], version: "t", home: "/h", debounceMs: 10, pollMs: 60_000 });
  const sent: DaemonMessage[] = [];
  const c = daemon.attach((m) => sent.push(m));
  c.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  sent.length = 0;
  c.handle({ type: "rename", requestId: "1", agent: "opencode", id: "x", title: "t" });
  c.handle({ type: "rename", requestId: "2", agent: "claude", id: "x", title: "t" });
  await tick(10);
  assert.deepEqual(sent, [
    { type: "renameResult", requestId: "1", ok: false, error: 'unknown agent "opencode"' },
    { type: "renameResult", requestId: "2", ok: false, error: "renaming claude sessions is not supported" },
  ]);
  daemon.stop();
});

test("rename before a completed hello answers handshake required and renames nothing", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1")];
  const fresh = h.attach();
  fresh.client.handle({ type: "rename", requestId: "r0", agent: "codex", id: "u1", title: "New name" });
  await tick(30);
  assert.deepEqual(fresh.sent, [{ type: "renameResult", requestId: "r0", ok: false, error: "handshake required" }]);
  assert.deepEqual(h.codex.renamed, []);
  h.daemon.stop();
});

test("parse move and moveResult messages", () => {
  assert.deepEqual(parseClientMessage('{"type":"move","requestId":"7","agent":"claude","id":"u1","cwd":"/z"}'), { type: "move", requestId: "7", agent: "claude", id: "u1", cwd: "/z" });
  assert.equal(parseClientMessage('{"type":"move","requestId":"7","agent":"claude","id":"u1"}'), undefined);
  assert.equal(parseClientMessage('{"type":"move","requestId":"7","agent":"claude","id":"u1","cwd":5}'), undefined);
  assert.equal(parseClientMessage('{"type":"move","agent":"claude","id":"u1","cwd":"/z"}'), undefined);
  assert.deepEqual(parseDaemonMessage('{"type":"moveResult","requestId":"7","ok":true}'), { type: "moveResult", requestId: "7", ok: true });
  assert.deepEqual(parseDaemonMessage('{"type":"moveResult","requestId":"7","ok":false,"error":"no"}'), { type: "moveResult", requestId: "7", ok: false, error: "no" });
  assert.equal(parseDaemonMessage('{"type":"moveResult","requestId":"7"}'), undefined);
  assert.equal(parseDaemonMessage('{"type":"moveResult","ok":true}'), undefined);
});

test("move answers only the requester, then every synced client gets the new folder", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1"), s("codex", "u2")];
  const { a, b } = await syncedPair(h);
  const aBefore = a.sent.length;
  const bBefore = b.sent.length;
  a.client.handle({ type: "move", requestId: "m1", agent: "codex", id: "u1", cwd: "/z" });
  await tick(30);
  assert.deepEqual(h.codex.moved, [["u1", "/z"]]);
  const aNew = a.sent.slice(aBefore);
  const bNew = b.sent.slice(bBefore);
  assert.deepEqual(aNew[0], { type: "moveResult", requestId: "m1", ok: true });
  assert.ok(!bNew.some((m) => m.type === "moveResult"));
  for (const msgs of [aNew, bNew]) {
    assert.deepEqual(msgs.filter((m) => m.type === "changed"), [{ type: "changed", upserted: [s("codex", "u1", { cwd: "/z" })], removed: [] }]);
  }
  h.daemon.stop();
});

test("a failed move answers ok:false with the provider's error and changes nothing", async () => {
  const h = setup();
  h.codex.sessions = [s("codex", "u1")];
  const { a, b } = await syncedPair(h);
  h.codex.moveError = new Error("the session is open in Claude Code (pid 7); close it in Claude Code first");
  const aBefore = a.sent.length;
  const bBefore = b.sent.length;
  a.client.handle({ type: "move", requestId: "m2", agent: "codex", id: "u1", cwd: "/z" });
  await tick(30);
  assert.deepEqual(a.sent.slice(aBefore), [{ type: "moveResult", requestId: "m2", ok: false, error: "the session is open in Claude Code (pid 7); close it in Claude Code first" }]);
  assert.equal(b.sent.length, bBefore);
  h.daemon.stop();
});

test("move for an unknown agent, a provider without move or before hello answers ok:false", async () => {
  const plain: SessionProvider = { agent: "claude", snapshot: async () => [], watch: () => ({ dispose: () => {} }) };
  const daemon = new Daemon({ providers: [plain], version: "t", home: "/h", debounceMs: 10, pollMs: 60_000 });
  const sent: DaemonMessage[] = [];
  const c = daemon.attach((m) => sent.push(m));
  c.handle({ type: "move", requestId: "0", agent: "claude", id: "x", cwd: "/z" });
  c.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  c.handle({ type: "move", requestId: "1", agent: "opencode", id: "x", cwd: "/z" });
  c.handle({ type: "move", requestId: "2", agent: "claude", id: "x", cwd: "/z" });
  await tick(10);
  assert.deepEqual(sent.filter((m) => m.type === "moveResult"), [
    { type: "moveResult", requestId: "0", ok: false, error: "handshake required" },
    { type: "moveResult", requestId: "1", ok: false, error: 'unknown agent "opencode"' },
    { type: "moveResult", requestId: "2", ok: false, error: "moving claude sessions is not supported" },
  ]);
  daemon.stop();
});
