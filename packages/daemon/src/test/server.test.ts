import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { chmod, mkdir, mkdtemp, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo, SessionProvider } from "@agent-sessions/core";
import { Daemon } from "../daemon.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { ensurePrivateDir, isPrivateDir, removeStaleSocket, serveOnSocket, type SocketServer } from "../server.js";

class FakeProvider implements SessionProvider {
  readonly agent = "claude" as const;
  sessions: SessionInfo[] = [{ agent: "claude", id: "a", title: "a", cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle" }];
  async snapshot() { return this.sessions; }
  watch() { return { dispose: () => {} }; }
}

async function client(path: string): Promise<{ socket: Socket; lines: string[]; send: (o: unknown) => void; next: () => Promise<string> }> {
  const socket = connect(path);
  await new Promise<void>((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
  const lines: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  createInterface({ input: socket }).on("line", (l) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); });
  return {
    socket, lines,
    send: (o) => socket.write(JSON.stringify(o) + "\n"),
    next: () => lines.length ? Promise.resolve(lines.shift()!) : new Promise((r) => waiters.push(r)),
  };
}
const closed = (s: Socket) => new Promise<void>((r) => (s.closed ? r() : s.once("close", () => r())));

async function setup(idleTimeoutMs = 60_000, graceMs?: number) {
  const dir = await mkdtemp(join(tmpdir(), "as-sock-"));
  const path = join(dir, "d.sock");
  const provider = new FakeProvider();
  let server!: SocketServer;
  const logs: string[] = [];
  const daemon = new Daemon({ providers: [provider], version: "t", home: "/h", debounceMs: 10, log: (m) => logs.push(m), onStop: () => server.finish() });
  server = await serveOnSocket(daemon, path, { idleTimeoutMs, graceMs, log: () => {} });
  return { dir, path, daemon, server, provider, logs };
}

test("two clients talk independently over the socket", async () => {
  const h = await setup();
  const a = await client(h.path);
  const b = await client(h.path);
  a.send({ type: "hello", protocol: PROTOCOL_VERSION });
  assert.equal(JSON.parse(await a.next()).type, "hello");
  a.send({ type: "snapshot" });
  assert.equal(JSON.parse(await a.next()).type, "snapshot");
  b.send({ type: "ping" });
  assert.equal(JSON.parse(await b.next()).type, "pong");
  assert.equal(h.daemon.clientCount, 2);
  a.socket.end();
  await closed(a.socket);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.daemon.clientCount, 1);
  b.socket.destroy();
  h.daemon.stop();
  await h.server.close();
});

test("bad line answers error, protocol mismatch ends that socket only", async () => {
  const h = await setup();
  const a = await client(h.path);
  const b = await client(h.path);
  a.socket.write("garbage\n");
  assert.equal(JSON.parse(await a.next()).type, "error");
  a.send({ type: "hello", protocol: 99 });
  assert.equal(JSON.parse(await a.next()).type, "error");
  await closed(a.socket);
  b.send({ type: "ping" });
  assert.equal(JSON.parse(await b.next()).type, "pong");
  b.socket.destroy();
  h.daemon.stop();
  await h.server.close();
});

test("shutdown closes every socket and resolves close()", async () => {
  const h = await setup();
  const a = await client(h.path);
  const b = await client(h.path);
  a.send({ type: "shutdown" });
  await Promise.all([closed(a.socket), closed(b.socket)]);
  await h.server.close();
  await assert.rejects(stat(h.path));
});

test("daemon stops after the idle timeout without clients", async () => {
  const h = await setup(50);
  const a = await client(h.path);
  a.socket.end();
  await closed(a.socket);
  const t0 = Date.now();
  await h.server.close();
  assert.ok(Date.now() - t0 < 2000);
  await assert.rejects(stat(h.path));
  assert.ok(h.logs.includes("stopping: idle timeout"), h.logs.join("\n"));
});

test("a new client cancels the idle timer", async () => {
  const h = await setup(60);
  const a = await client(h.path);
  a.socket.end();
  await closed(a.socket);
  await new Promise((r) => setTimeout(r, 30));
  const b = await client(h.path);
  await new Promise((r) => setTimeout(r, 60));
  b.send({ type: "ping" });
  assert.equal(JSON.parse(await b.next()).type, "pong");
  b.socket.destroy();
  h.daemon.stop();
  await h.server.close();
});

test("removeStaleSocket deletes a dead socket file and keeps a live one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-stale-"));
  const dead = join(dir, "dead.sock");
  await writeFile(dead, "");
  await removeStaleSocket(dead);
  await assert.rejects(stat(dead));
  await removeStaleSocket(join(dir, "missing.sock"));
  const h = await setup();
  await removeStaleSocket(h.path);
  await stat(h.path);
  h.daemon.stop();
  await h.server.close();
});

test("a client reset mid-write does not crash the server", async () => {
  let crash: unknown;
  const guard = (err: unknown) => { crash = err; };
  process.once("uncaughtException", guard);
  try {
    const h = await setup();
    const title = "x".repeat(300);
    h.provider.sessions = Array.from({ length: 20_000 }, (_, i) => ({ agent: "claude" as const, id: `s${i}`, title, cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle" as const }));
    const socket = connect(h.path);
    await new Promise<void>((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
    socket.on("error", () => {});
    socket.pause();
    socket.write(JSON.stringify({ type: "snapshot" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const b = await client(h.path);
    b.send({ type: "ping" });
    assert.equal(JSON.parse(await b.next()).type, "pong");
    b.socket.destroy();
    h.daemon.stop();
    await h.server.close();
    assert.equal(crash, undefined);
  } finally {
    process.off("uncaughtException", guard);
  }
});

test("finish removes the socket file immediately", async () => {
  const h = await setup(60_000, 50);
  // Half-open and paused: this client never finishes its side of the close.
  const socket = connect({ path: h.path, allowHalfOpen: true });
  await new Promise<void>((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
  socket.on("error", () => {});
  socket.pause();
  h.daemon.stop();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(stat(h.path));
  await h.server.close();
  socket.destroy();
});

test("finish destroys clients that do not close within the grace period", async () => {
  const h = await setup(60_000, 50);
  const socket = connect({ path: h.path, allowHalfOpen: true });
  await new Promise<void>((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
  socket.on("error", () => {});
  socket.resume();
  const t0 = Date.now();
  h.daemon.stop();
  await h.server.close();
  const took = Date.now() - t0;
  assert.ok(took < 150, `close took ${took}ms`);
  socket.destroy();
});

test("serveOnSocket rejects a socket path that is too long", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-long-"));
  const path = join(dir, "x".repeat(Math.max(1, 120 - dir.length - 1)));
  assert.ok(Buffer.byteLength(path) >= 120);
  const daemon = new Daemon({ providers: [new FakeProvider()], version: "t", home: "/h" });
  await assert.rejects(serveOnSocket(daemon, path, { idleTimeoutMs: 60_000, log: () => {} }), /too long/);
  daemon.stop();
});

test("ensurePrivateDir narrows an inherited directory and refuses a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-private-"));
  await ensurePrivateDir(join(root, "sock"));
  assert.equal((await stat(join(root, "sock"))).mode & 0o777, 0o700);
  for (const mode of [0o775, 0o777]) {
    const old = join(root, `old-${mode.toString(8)}`);
    await mkdir(old);
    await chmod(old, mode);
    await ensurePrivateDir(old);
    assert.equal((await stat(old)).mode & 0o777, 0o700);
  }
  await symlink(join(root, "sock"), join(root, "link"));
  await assert.rejects(ensurePrivateDir(join(root, "link")), /unsafe socket directory/);
});

test("isPrivateDir accepts, narrows or refuses", () => {
  const st = (mode: number, uid: number, dir = true) => ({ mode, uid, isDirectory: () => dir });
  assert.equal(isPrivateDir(st(0o40700, 1000), 1000), "ok");
  assert.equal(isPrivateDir(st(0o40777, 1000), 1000), "narrow");
  assert.equal(isPrivateDir(st(0o40700, 0), 1000), "refuse");
  assert.equal(isPrivateDir(st(0o120777, 1000, false), 1000), "refuse");
});
