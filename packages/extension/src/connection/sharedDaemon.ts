import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, closeSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";

export interface SharedDaemonPaths {
  socket: string;
  lock: string;
  log: string;
  /** Written by the daemon at startup: its reported version. */
  version: string;
  /** Written by the daemon at startup and removed when it stops: its pid. */
  pid: string;
}

export function socketDir(env: NodeJS.ProcessEnv, home: string): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, "agent-sessions") : join(home, ".local", "share", "agent-sessions");
}

export function sharedDaemonPaths(dir: string): SharedDaemonPaths {
  return { socket: join(dir, "daemon.sock"), lock: join(dir, "daemon.lock"), log: join(dir, "daemon.log"), version: join(dir, "daemon.version"), pid: join(dir, "daemon.pid") };
}

/**
 * The first 12 hex digits of the sha256 of the daemon bundle at `path`. The
 * daemon computes the same over its own file and reports
 * `<package version>+<build id>`, so any rebuild changes its identity.
 */
export async function daemonBuildId(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 12);
}

/**
 * How many more milliseconds the running daemon counts as freshly started, or
 * 0. The daemon writes its version to `versionFile` at startup; when that file
 * names the running version and is younger than `maxAgeMs`, some window has
 * just started this daemon on purpose (possibly one with a different bundle),
 * and an automatic restart now would only make windows with different
 * bundles replace each other's daemon back and forth. Build ids are not
 * ordered, so "newer" cannot be decided; instead every daemon gets at least
 * `maxAgeMs` before another window may auto-restart it.
 */
export async function daemonFreshForMs(versionFile: string, runningVersion: string, now: number, maxAgeMs = 60_000): Promise<number> {
  try {
    const [text, st] = await Promise.all([readFile(versionFile, "utf8"), stat(versionFile)]);
    if (text.trim() !== runningVersion) return 0;
    return Math.max(0, st.mtimeMs + maxAgeMs - now);
  } catch {
    return 0;
  }
}

/**
 * Connects to a unix socket. The error listener stays attached for the life of
 * the socket, so an error between the handover and the consumer attaching its
 * own listeners cannot crash the process; the consumer still sees `close`.
 */
export function connectSocket(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Creates the lock file exclusively. A lock older than `staleMs` is taken over.
 * Retries only when the lock vanished under us, at most `attempts` times.
 */
export async function acquireLock(lockPath: string, staleMs: number, now: number, attempts = 3): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx");
    try {
      await fh.writeFile(String(process.pid));
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  try {
    const st = await stat(lockPath);
    if (now - st.mtimeMs <= staleMs) return false;
    await unlink(lockPath);
  } catch (err) {
    // ENOENT: another window removed the lock between the calls; anything
    // else (such as EACCES) will not go away by retrying.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return attempts > 1 ? acquireLock(lockPath, staleMs, now, attempts - 1) : false;
}

export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // already gone
  }
}

/**
 * Whether a failed connect means the socket file is missing or nobody listens
 * on it, so it may be replaced. A timeout or a permission error may hide a
 * live daemon and must not delete its socket.
 */
export function shouldReplaceSocket(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export interface EnsureOptions {
  paths: SharedDaemonPaths;
  spawnDaemon: () => void;
  connectTimeoutMs?: number;
  retryMs?: number;
  log: (msg: string) => void;
  /** Replaces `connectSocket`; for tests. */
  connect?: (path: string, timeoutMs: number) => Promise<Socket>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connects to the shared daemon, spawning it first when nothing listens. */
export async function ensureSharedDaemon(opts: EnsureOptions): Promise<Socket> {
  const timeoutMs = opts.connectTimeoutMs ?? 5000;
  const retryMs = opts.retryMs ?? 100;
  const connectTo = opts.connect ?? connectSocket;
  const { socket, lock } = opts.paths;
  try {
    return await connectTo(socket, 1000);
  } catch {
    // nothing listening yet
  }
  await mkdir(dirname(lock), { recursive: true });
  let held = await acquireLock(lock, 30_000, Date.now());
  try {
    if (held) {
      // Another window may have started the daemon between our first connect
      // and taking the lock; check again before replacing anything.
      let lastErr: unknown;
      try {
        return await connectTo(socket, 1000);
      } catch (err) {
        lastErr = err;
      }
      if (shouldReplaceSocket(lastErr)) {
        try {
          await unlink(socket);
        } catch {
          // no stale socket file
        }
        opts.log("starting shared daemon");
        opts.spawnDaemon();
      } else {
        opts.log(`daemon socket did not answer (${String(lastErr)}), waiting without spawning`);
        held = false;
        await releaseLock(lock);
      }
    } else {
      opts.log("another window is starting the daemon, waiting");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(retryMs);
      try {
        return await connectTo(socket, 1000);
      } catch {
        // keep waiting
      }
    }
  } finally {
    if (held) await releaseLock(lock);
  }
  const tail = await tailOfLog(opts.paths.log);
  throw new Error(`shared daemon did not come up at ${socket} within ${timeoutMs} ms${tail ? `: ${tail}` : ""}`);
}

/** Starts the daemon detached from this process, appending its output to `logPath`. */
export async function spawnDetachedDaemon(
  daemonPath: string,
  socketPath: string,
  logPath: string,
  onError?: (err: Error) => void,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [daemonPath, "--listen", socketPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (err) => onError?.(err));
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/** The pid in the daemon's pid file, if there is a valid one. */
export async function readDaemonPid(pidFile: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `pid` is a running shared daemon. On Linux its command line must
 * name `--listen`, so a stale pid file whose pid was reused by another
 * process is ignored; elsewhere only the existence of the process is checked.
 */
export function daemonProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.includes("--listen") && args.some((a) => a.endsWith("daemon.mjs"));
  } catch {
    return false;
  }
}

export interface StopDaemonOptions {
  /** How long to wait after SIGTERM, and again after SIGKILL. */
  waitMs: number;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  /** The daemon's pid, read before asking it to shut down; read from the pid file when absent. */
  pid?: number;
  pollMs?: number;
}

/**
 * Makes sure the daemon process is gone: SIGTERM, then SIGKILL after
 * `waitMs`. A daemon that did not stop cleanly leaves its socket and pid file
 * behind; both are removed while the pid file still names the stopped pid,
 * never after a successor has written its own. Returns "none" when there was
 * no live daemon process.
 */
export async function stopDaemonProcess(paths: Pick<SharedDaemonPaths, "socket" | "pid">, opts: StopDaemonOptions): Promise<"none" | "exited" | "killed"> {
  const pid = opts.pid ?? (await readDaemonPid(paths.pid));
  if (pid === undefined) return "none";
  const pollMs = opts.pollMs ?? 100;
  const waitForExit = async () => {
    for (let waited = 0; waited < opts.waitMs; waited += pollMs) {
      if (!opts.isAlive(pid)) return true;
      await sleep(pollMs);
    }
    return !opts.isAlive(pid);
  };
  const signal = (s: NodeJS.Signals) => {
    try {
      opts.kill(pid, s);
    } catch {
      // exited meanwhile
    }
  };
  let result: "none" | "exited" | "killed" = "none";
  if (opts.isAlive(pid)) {
    signal("SIGTERM");
    if (await waitForExit()) {
      result = "exited";
    } else {
      signal("SIGKILL");
      await waitForExit();
      result = "killed";
    }
  }
  if ((await readDaemonPid(paths.pid)) === pid) {
    for (const f of [paths.socket, paths.pid]) {
      try {
        await unlink(f);
      } catch {
        // already gone
      }
    }
  }
  return result;
}

const TAIL_BYTES = 64 * 1024;

/** The last `lines` non-empty lines of the log, joined by " | "; reads at most the last 64 KB. */
export async function tailOfLog(logPath: string, lines = 5): Promise<string> {
  try {
    const fh = await open(logPath, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      // Starting mid-file cuts the first line; drop it.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-lines).join(" | ");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}
