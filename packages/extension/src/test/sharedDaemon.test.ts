import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { chmod, mkdtemp, readFile, writeFile, utimes, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, connectSocket, daemonBuildId, daemonFreshForMs, ensureSharedDaemon, releaseLock, sharedDaemonPaths, shouldReplaceSocket, socketDir, tailOfLog } from "../connection/sharedDaemon.js";

test("socketDir prefers XDG_RUNTIME_DIR and falls back to home", () => {
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u"), "/run/user/1/agent-sessions");
  assert.equal(socketDir({}, "/Users/u"), "/Users/u/.local/share/agent-sessions");
  const p = sharedDaemonPaths("/x");
  assert.deepEqual(p, { socket: "/x/daemon.sock", lock: "/x/daemon.lock", log: "/x/daemon.log", version: "/x/daemon.version" });
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

test("does not spawn when the daemon appears between the first connect and the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-shared-"));
  const paths = sharedDaemonPaths(dir);
  let server: Server | undefined;
  let calls = 0;
  let spawned = 0;
  // The first connect fails as if nothing listened; another window's daemon
  // comes up before this one takes the lock.
  const connect = async (path: string, timeoutMs: number) => {
    if (calls++ === 0) {
      server = await listen(path);
      server.on("connection", (c) => c.pipe(c));
      throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    }
    return connectSocket(path, timeoutMs);
  };
  const socket = await ensureSharedDaemon({ paths, connect, retryMs: 20, connectTimeoutMs: 2000, spawnDaemon: () => { spawned++; }, log: () => {} });
  assert.equal(spawned, 0);
  assert.equal(calls, 2);
  await stat(paths.socket);
  await assert.rejects(stat(paths.lock));
  const echoed = new Promise<string>((res) => socket.once("data", (d) => res(String(d))));
  socket.write("ping\n");
  assert.equal(await echoed, "ping\n");
  socket.destroy();
  server?.close();
});

test("shouldReplaceSocket only allows replacing a dead or missing socket", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  assert.equal(shouldReplaceSocket(err("ENOENT")), true);
  assert.equal(shouldReplaceSocket(err("ECONNREFUSED")), true);
  assert.equal(shouldReplaceSocket(new Error("connect timeout")), false);
  assert.equal(shouldReplaceSocket(err("EACCES")), false);
  assert.equal(shouldReplaceSocket(undefined), false);
});

test("acquireLock gives up on a stale lock it cannot remove", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores directory mode bits");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "as-lock-"));
  const lock = join(dir, "daemon.lock");
  await writeFile(lock, "1");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await chmod(dir, 0o500);
  try {
    assert.equal(await acquireLock(lock, 30_000, Date.now()), false);
  } finally {
    await chmod(dir, 0o700);
  }
});

test("daemonBuildId is the first 12 hex digits of the file's sha256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-build-"));
  const file = join(dir, "daemon.mjs");
  await writeFile(file, "console.log('daemon');\n");
  const expected = createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 12);
  assert.equal(await daemonBuildId(file), expected);
  assert.match(expected, /^[0-9a-f]{12}$/);
});

test("daemonFreshForMs protects a daemon whose version file is young and matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-version-"));
  const file = join(dir, "daemon.version");
  assert.equal(await daemonFreshForMs(file, "0.1.0+aaa", Date.now()), 0, "missing file");
  await writeFile(file, "0.1.0+aaa");
  const mtime = (await stat(file)).mtimeMs;
  assert.equal(await daemonFreshForMs(file, "0.1.0+aaa", mtime + 10_000), 50_000);
  assert.equal(await daemonFreshForMs(file, "0.1.0+bbb", mtime + 10_000), 0, "another daemon's file");
  assert.equal(await daemonFreshForMs(file, "0.1.0+aaa", mtime + 61_000), 0, "old file");
});
