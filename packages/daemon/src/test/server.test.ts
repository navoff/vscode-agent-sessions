import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo, SessionProvider } from "@agent-sessions/core";
import { Daemon } from "../daemon.js";
import { removeStaleSocket, serveOnSocket, type SocketServer } from "../server.js";

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

async function setup(idleTimeoutMs = 60_000) {
  const dir = await mkdtemp(join(tmpdir(), "as-sock-"));
  const path = join(dir, "d.sock");
  let server!: SocketServer;
  const daemon = new Daemon({ providers: [new FakeProvider()], version: "t", home: "/h", debounceMs: 10, onStop: () => server.finish() });
  server = await serveOnSocket(daemon, path, { idleTimeoutMs, log: () => {} });
  return { dir, path, daemon, server };
}

test("two clients talk independently over the socket", async () => {
  const h = await setup();
  const a = await client(h.path);
  const b = await client(h.path);
  a.send({ type: "hello", protocol: 1 });
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
