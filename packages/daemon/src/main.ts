import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProvider, CodexProvider } from "@agent-sessions/core";
import { Daemon } from "./daemon.js";
import { parseClientMessage, type DaemonMessage } from "./protocol.js";
import { removeStaleSocket, serveOnSocket, type SocketServer } from "./server.js";

declare const __DAEMON_VERSION__: string | undefined;
const VERSION = typeof __DAEMON_VERSION__ === "string" ? __DAEMON_VERSION__ : "0.0.0-dev";

/**
 * The first 12 hex digits of the sha256 of this bundle. The extension hashes
 * its bundled copy the same way, so any change to daemon.mjs changes the
 * reported version without a manual package.json bump.
 */
function buildId(): string {
  try {
    return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

// On stdin close we must let any in-flight refresh (triggered by a "snapshot"
// message) land before stopping the daemon and exiting, otherwise the reply can
// be dropped silently. EXIT_GRACE_MS caps how long we wait for a stuck provider
// before exiting anyway; stop() only runs after the wait, since stopping first
// would suppress the pending send.
const EXIT_GRACE_MS = 5000;
// In --listen mode the daemon stops once it has had no clients for this long.
const IDLE_TIMEOUT_MS = 60_000;

export function main(argv: string[]): void {
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const version = `${VERSION}+${buildId()}`;
  const home = homedir();
  const log = (msg: string) => process.stderr.write(`[daemon] ${msg}\n`);
  const providers = [
    new ClaudeProvider({ claudeDir: process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), log }),
    new CodexProvider({ codexDir: process.env.CODEX_HOME ?? join(home, ".codex"), log }),
  ];

  const listenAt = argv.indexOf("--listen");
  if (listenAt >= 0) {
    const socketPath = argv[listenAt + 1];
    if (!socketPath) {
      process.stderr.write("usage: daemon.mjs --listen <socket path>\n");
      process.exit(2);
    }
    void (async () => {
      await mkdir(dirname(socketPath), { recursive: true });
      await removeStaleSocket(socketPath);
      const pidFile = join(dirname(socketPath), "daemon.pid");
      // Removes the pid file unless a successor has already replaced it.
      const removePidFile = () => {
        try {
          if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) unlinkSync(pidFile);
        } catch {
          // already gone
        }
      };
      let server!: SocketServer;
      const daemon = new Daemon({
        providers,
        version,
        home,
        log,
        onStop: () => {
          removePidFile();
          server.finish();
        },
      });
      server = await serveOnSocket(daemon, socketPath, { idleTimeoutMs: IDLE_TIMEOUT_MS, log });
      // The extension's restart command kills this pid when the daemon does
      // not exit on "shutdown" (a hung event loop).
      await writeFile(pidFile, String(process.pid));
      // Read by the extension before an automatic restart, see daemonFreshForMs.
      await writeFile(join(dirname(socketPath), "daemon.version"), version);
      log(`listening on ${socketPath} (version ${version}, pid ${process.pid})`);
      const stop = () => daemon.stop();
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      await server.close();
      process.exit(0);
    })().catch((err) => {
      log(`listen failed: ${String(err)}`);
      process.exit(1);
    });
    return;
  }

  const send = (m: DaemonMessage) => {
    process.stdout.write(JSON.stringify(m) + "\n");
  };
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    process.exit(0);
  };
  // stop() runs on "shutdown"; exit on the next turn so anything written just
  // before is flushed. A protocol mismatch only detaches the client and is
  // handled in the line handler below.
  const daemon = new Daemon({ providers, version, home, log, onStop: () => setImmediate(exit) });
  const client = daemon.attach(send);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = parseClientMessage(line);
    if (!msg) {
      send({ type: "error", message: `bad message: ${line.slice(0, 200)}` });
      return;
    }
    client.handle(msg);
    // A protocol mismatch detaches the only stdio client: flush and exit.
    if (client.detached && !daemon.clientCount) process.stdout.write("", () => { daemon.stop(); exit(); });
  });
  rl.on("close", () => {
    void Promise.race([daemon.drain(), new Promise<void>((r) => setTimeout(r, EXIT_GRACE_MS).unref())]).then(() => {
      daemon.stop();
      exit();
    });
  });
}

main(process.argv.slice(2));
