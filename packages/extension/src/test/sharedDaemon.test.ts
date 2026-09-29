import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtemp, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, connectSocket, ensureSharedDaemon, releaseLock, sharedDaemonPaths, socketDir, tailOfLog } from "../connection/sharedDaemon.js";

test("socketDir prefers XDG_RUNTIME_DIR and falls back to home", () => {
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u"), "/run/user/1/agent-sessions");
  assert.equal(socketDir({}, "/Users/u"), "/Users/u/.local/share/agent-sessions");
  const p = sharedDaemonPaths("/x");
  assert.deepEqual(p, { socket: "/x/daemon.sock", lock: "/x/daemon.lock", log: "/x/daemon.log" });
});

test("acquireLock is exclusive and ignores stale locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-lock-"));
  const lock = join(dir, "daemon.lock");
  assert.equal(await acquireLock(lock, 30_000, Date.now()), true);
  assert.equal(await acquireLock(lock, 30_000, Date.now()), false);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal(await acquireLock(lock, 30_000, Date.now()), true);
  await releaseLock(lock);
  await assert.rejects(stat(lock));
  await releaseLock(lock);
});

function listen(path: string): Promise<Server> {
  return new Promise((res) => { const s = createServer(); s.listen(path, () => res(s)); });
}

test("ensureSharedDaemon connects to a running daemon without spawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-shared-"));
  const paths = sharedDaemonPaths(dir);
  const server = await listen(paths.socket);
  let spawned = 0;
  const socket = await ensureSharedDaemon({ paths, spawnDaemon: () => { spawned++; }, log: () => {} });
  assert.equal(spawned, 0);
  socket.destroy();
  server.close();
});

test("ensureSharedDaemon spawns once and retries until the socket appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-shared-"));
  const paths = sharedDaemonPaths(dir);
  await writeFile(paths.socket, "");
  let server: Server | undefined;
  let spawned = 0;
  const socket = await ensureSharedDaemon({
    paths, retryMs: 20, connectTimeoutMs: 2000, log: () => {},
    spawnDaemon: () => { spawned++; setTimeout(() => { void listen(paths.socket).then((s) => (server = s)); }, 100); },
  });
  assert.equal(spawned, 1);
  await assert.rejects(stat(paths.lock));
  socket.destroy();
  server?.close();
});

test("ensureSharedDaemon fails after the timeout and releases the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-shared-"));
  const paths = sharedDaemonPaths(dir);
  await assert.rejects(
    () => ensureSharedDaemon({ paths, retryMs: 20, connectTimeoutMs: 150, spawnDaemon: () => {}, log: () => {} }),
    /did not come up/,
  );
  await assert.rejects(stat(paths.lock));
});

test("ensureSharedDaemon waits for another window's spawn when the lock is taken", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-shared-"));
  const paths = sharedDaemonPaths(dir);
  assert.equal(await acquireLock(paths.lock, 30_000, Date.now()), true);
  let spawned = 0;
  let server: Server | undefined;
  setTimeout(() => { void listen(paths.socket).then((s) => (server = s)); }, 100);
  const socket = await ensureSharedDaemon({ paths, retryMs: 20, connectTimeoutMs: 2000, spawnDaemon: () => { spawned++; }, log: () => {} });
  assert.equal(spawned, 0);
  socket.destroy();
  server?.close();
  await releaseLock(paths.lock);
});

test("connectSocket rejects on a missing socket", async () => {
  await assert.rejects(() => connectSocket("/nonexistent/x.sock", 100));
});

test("tailOfLog returns the last lines and reads only the end of a large log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-log-"));
  const log = join(dir, "daemon.log");
  assert.equal(await tailOfLog(log), "");
  const filler = "x".repeat(99) + "\n";
  await writeFile(log, "FIRST\n" + filler.repeat(2000) + "a\n\nb\nc\nd\ne\nf\n");
  assert.equal(await tailOfLog(log), "b | c | d | e | f");
  assert.equal(await tailOfLog(log, 2000).then((t) => t.includes("FIRST")), false);
});
