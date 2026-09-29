import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile, utimes, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, connectSocket, daemonBuildId, daemonFreshForMs, daemonProcessAlive, ensurePrivateDir, ensureSharedDaemon, isPrivateDir, readDaemonPid, rotateLog, stopDaemonProcess, releaseLock, sharedDaemonPaths, shouldReplaceSocket, socketDir, tailOfLog } from "../connection/sharedDaemon.js";

test("socketDir prefers XDG_RUNTIME_DIR and falls back to home", () => {
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u"), "/run/user/1/agent-sessions");
  assert.equal(socketDir({}, "/Users/u"), "/Users/u/.local/share/agent-sessions");
  const p = sharedDaemonPaths("/x");
  assert.deepEqual(p, { socket: "/x/daemon.sock", lock: "/x/daemon.lock", log: "/x/daemon.log", version: "/x/daemon.version", pid: "/x/daemon.pid" });
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

test("ensureSharedDaemon fails after the timeout with the log tail and releases the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-shared-"));
  const paths = sharedDaemonPaths(dir);
  await writeFile(paths.log, "old run\nlisten failed: Error: listen EADDRINUSE\n");
  await assert.rejects(
    () => ensureSharedDaemon({ paths, retryMs: 20, connectTimeoutMs: 150, spawnDaemon: () => {}, log: () => {} }),
    /did not come up .* within 150 ms: old run \| listen failed: Error: listen EADDRINUSE$/,
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

async function daemonFiles(pid: string) {
  const dir = await mkdtemp(join(tmpdir(), "as-stop-"));
  const paths = sharedDaemonPaths(dir);
  await writeFile(paths.socket, "");
  if (pid) await writeFile(paths.pid, pid);
  const exists = async (f: string) => stat(f).then(() => true, () => false);
  return { paths, exists };
}

/** A fake process table: `pid` stays alive until it receives one of `diesOn`. */
function fakeProcess(pid: number, diesOn: NodeJS.Signals[]) {
  let alive = true;
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    kill: (p: number, s: NodeJS.Signals) => {
      assert.equal(p, pid);
      signals.push(s);
      if (diesOn.includes(s)) alive = false;
    },
    isAlive: (p: number) => p === pid && alive,
  };
}

test("stopDaemonProcess does nothing without a pid file", async () => {
  const { paths, exists } = await daemonFiles("");
  const proc = fakeProcess(4242, ["SIGTERM"]);
  assert.equal(await stopDaemonProcess(paths, { waitMs: 100, pollMs: 10, ...proc }), "none");
  assert.deepEqual(proc.signals, []);
  assert.equal(await exists(paths.socket), true, "a socket without our pid file may belong to a successor");
});

test("stopDaemonProcess terminates a daemon that exits on SIGTERM and removes its files", async () => {
  const { paths, exists } = await daemonFiles("4242\n");
  assert.equal(await readDaemonPid(paths.pid), 4242);
  const proc = fakeProcess(4242, ["SIGTERM"]);
  assert.equal(await stopDaemonProcess(paths, { waitMs: 100, pollMs: 10, ...proc }), "exited");
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  assert.equal(await exists(paths.socket), false);
  assert.equal(await exists(paths.pid), false);
});

test("stopDaemonProcess kills a daemon that ignores SIGTERM", async () => {
  const { paths, exists } = await daemonFiles("4242");
  const proc = fakeProcess(4242, ["SIGKILL"]);
  const start = Date.now();
  assert.equal(await stopDaemonProcess(paths, { waitMs: 100, pollMs: 10, ...proc }), "killed");
  assert.ok(Date.now() - start >= 90, "waits before SIGKILL");
  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(await exists(paths.socket), false);
  assert.equal(await exists(paths.pid), false);
});

test("stopDaemonProcess cleans up after a dead daemon and spares a successor's files", async () => {
  const dead = await daemonFiles("4242");
  const none = fakeProcess(1, []);
  assert.equal(await stopDaemonProcess(dead.paths, { waitMs: 100, pollMs: 10, ...none }), "none");
  assert.deepEqual(none.signals, []);
  assert.equal(await dead.exists(dead.paths.socket), false, "stale socket removed");

  // The pid read before the shutdown is gone; the file now names a successor.
  const next = await daemonFiles("5555");
  const proc = fakeProcess(4242, ["SIGTERM"]);
  assert.equal(await stopDaemonProcess(next.paths, { pid: 4242, waitMs: 100, pollMs: 10, ...proc }), "exited");
  assert.equal(await next.exists(next.paths.socket), true);
  assert.equal(await readDaemonPid(next.paths.pid), 5555);
});

test("daemonProcessAlive rejects dead pids and processes that are not the daemon", () => {
  assert.equal(daemonProcessAlive(2 ** 22 + 1), false);
  // This test runner is alive but is not "daemon.mjs --listen".
  assert.equal(daemonProcessAlive(process.pid), process.platform !== "linux");
});

test("ensureSharedDaemon refuses a symlinked socket directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-unsafe-"));
  await mkdir(join(root, "real"));
  await symlink(join(root, "real"), join(root, "link"));
  let spawned = 0;
  await assert.rejects(
    () => ensureSharedDaemon({ paths: sharedDaemonPaths(join(root, "link")), retryMs: 20, connectTimeoutMs: 150, spawnDaemon: () => { spawned++; }, log: () => {} }),
    /unsafe socket directory/,
  );
  assert.equal(spawned, 0);
});

test("ensurePrivateDir creates 0700 directories and narrows inherited 0775 and 0777 ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-private-"));
  const fresh = join(root, "a", "agent-sessions");
  await ensurePrivateDir(fresh);
  assert.equal((await stat(fresh)).mode & 0o777, 0o700);
  for (const mode of [0o775, 0o777]) {
    const old = join(root, `old-${mode.toString(8)}`);
    await mkdir(old);
    await chmod(old, mode);
    await ensurePrivateDir(old);
    assert.equal((await stat(old)).mode & 0o777, 0o700);
  }
});

test("isPrivateDir accepts, narrows or refuses", () => {
  const st = (mode: number, uid: number, dir = true) => ({ mode, uid, isDirectory: () => dir });
  assert.equal(isPrivateDir(st(0o40700, 1000), 1000), "ok");
  assert.equal(isPrivateDir(st(0o40775, 1000), 1000), "narrow");
  assert.equal(isPrivateDir(st(0o40700, 0), 1000), "refuse", "another user's directory");
  assert.equal(isPrivateDir(st(0o120777, 1000, false), 1000), "refuse", "symlink");
  assert.equal(isPrivateDir(st(0o40777, 0), undefined), "narrow", "no getuid on this platform");
});

test("rotateLog moves a log over the limit to .1 and keeps a small one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-rotate-"));
  const log = join(dir, "daemon.log");
  await rotateLog(log, 10);
  await writeFile(log, "small");
  await rotateLog(log, 10);
  assert.equal(await readFile(log, "utf8"), "small");
  await writeFile(`${log}.1`, "older");
  await writeFile(log, "more than ten bytes");
  await rotateLog(log, 10);
  await assert.rejects(stat(log));
  assert.equal(await readFile(`${log}.1`, "utf8"), "more than ten bytes");
});
