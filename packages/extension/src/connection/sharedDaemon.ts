import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";

export interface SharedDaemonPaths {
  socket: string;
  lock: string;
  log: string;
}

export function socketDir(env: NodeJS.ProcessEnv, home: string): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, "agent-sessions") : join(home, ".local", "share", "agent-sessions");
}

export function sharedDaemonPaths(dir: string): SharedDaemonPaths {
  return { socket: join(dir, "daemon.sock"), lock: join(dir, "daemon.lock"), log: join(dir, "daemon.log") };
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
  throw new Error(`shared daemon did not come up at ${socket} within ${timeoutMs} ms`);
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
