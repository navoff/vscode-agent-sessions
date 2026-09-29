import { createServer, connect, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Daemon } from "./daemon.js";
import { parseClientMessage } from "./protocol.js";

export interface SocketServerOptions {
  idleTimeoutMs: number;
  /** How long finish() waits for clients to close before destroying them. Default 2000. */
  graceMs?: number;
  log: (msg: string) => void;
}

const DEFAULT_GRACE_MS = 2000;
// sun_path holds 108 bytes on Linux and 104 on macOS, including the NUL.
// Longer paths are silently truncated by the kernel, so refuse them.
const MAX_SOCKET_PATH_BYTES = 103;

export interface SocketServer {
  readonly address: string;
  /** Call from the daemon's onStop: ends every socket and closes the server. */
  finish(): void;
  /** Resolves once finish() has removed the socket file and every connection is closed. */
  close(): Promise<void>;
}

/** Deletes `path` when nothing listens on it. A live socket is left alone. */
export async function removeStaleSocket(path: string): Promise<void> {
  const alive = await new Promise<boolean>((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", (err: NodeJS.ErrnoException) => resolve(err.code !== "ECONNREFUSED" && err.code !== "ENOENT"));
  });
  if (alive) return;
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}

export function serveOnSocket(daemon: Daemon, socketPath: string, opts: SocketServerOptions): Promise<SocketServer> {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return Promise.reject(new Error(`socket path too long (${Buffer.byteLength(socketPath)} bytes, max ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`));
  }
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const sockets = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => (closedResolve = r));

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (daemon.clientCount === 0) {
        opts.log("no clients, stopping");
        daemon.stop();
      }
    }, opts.idleTimeoutMs);
  };

  const server: Server = createServer((socket) => {
    // A connection accepted while finishing must not attach to a stopped daemon.
    if (finished) {
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    sockets.add(socket);
    opts.log(`client connected (${sockets.size})`);
    if (idleTimer) clearTimeout(idleTimer);
    const client = daemon.attach((m) => {
      if (!socket.destroyed) socket.write(JSON.stringify(m) + "\n");
    });
    const rl = createInterface({ input: socket });
    // readline re-emits socket errors; the socket's own handler logs them.
    rl.on("error", () => {});
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = parseClientMessage(line);
      if (!msg) {
        socket.write(JSON.stringify({ type: "error", message: `bad message: ${line.slice(0, 200)}` }) + "\n");
        return;
      }
      client.handle(msg);
      if (client.detached) {
        socket.end();
        // Lines after the one that detached us must not be parsed.
        rl.close();
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      opts.log(`client disconnected (${sockets.size})`);
      client.detach();
      if (!finished && daemon.clientCount === 0) armIdle();
    });
    socket.on("error", (err) => opts.log(`socket error: ${String(err)}`));
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const s of sockets) s.end();
    const serverClosed = new Promise<void>((r) => server.close(() => r()));
    // Remove the file now, not after every client is gone: the listening fd is
    // already closed, so a successor daemon may bind this path meanwhile.
    const unlinked = unlink(socketPath).catch(() => {});
    graceTimer = setTimeout(() => {
      for (const s of sockets) s.destroy();
    }, graceMs);
    void Promise.all([serverClosed, unlinked]).then(() => {
      clearTimeout(graceTimer);
      closedResolve();
    });
  };

  return new Promise<SocketServer>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(socketPath, () => {
      server.off("error", rejectServer);
      server.on("error", (err) => opts.log(`server error: ${String(err)}`));
      armIdle();
      resolveServer({ address: socketPath, finish, close: () => closed });
    });
  });
}
