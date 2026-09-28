import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider, CodexProvider } from "@agent-sessions/core";
import { Daemon } from "./daemon.js";
import { parseClientMessage, type DaemonMessage } from "./protocol.js";

declare const __DAEMON_VERSION__: string | undefined;
const VERSION = typeof __DAEMON_VERSION__ === "string" ? __DAEMON_VERSION__ : "0.0.0-dev";

// Every message Daemon#handle() processes results in exactly one send() call,
// either synchronously (hello, ping, hello-protocol-mismatch error) or after an
// async refresh (snapshot). On stdin close we must let any in-flight async send
// land before stopping the daemon and exiting, otherwise a "snapshot" requested
// just before the client disconnects can be dropped silently. EXIT_GRACE_MS caps
// how long we wait for a stuck provider before exiting anyway.
const EXIT_GRACE_MS = 5000;

export function main(argv: string[]): void {
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const home = homedir();
  const log = (msg: string) => process.stderr.write(`[daemon] ${msg}\n`);
  const providers = [
    new ClaudeProvider({ claudeDir: process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), log }),
    new CodexProvider({ codexDir: process.env.CODEX_HOME ?? join(home, ".codex"), log }),
  ];
  let pending = 0;
  const send = (m: DaemonMessage) => {
    if (pending > 0) pending--;
    process.stdout.write(JSON.stringify(m) + "\n");
  };
  const daemon = new Daemon({ providers, send, version: VERSION, home, log });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = parseClientMessage(line);
    if (!msg) {
      send({ type: "error", message: `bad message: ${line.slice(0, 200)}` });
      return;
    }
    pending++;
    daemon.handle(msg);
  });
  rl.on("close", () => {
    const deadline = Date.now() + EXIT_GRACE_MS;
    const finish = () => {
      daemon.stop();
      process.exit(0);
    };
    const waitForPending = () => {
      if (pending <= 0 || Date.now() >= deadline) {
        finish();
        return;
      }
      setImmediate(waitForPending);
    };
    waitForPending();
  });
}

main(process.argv.slice(2));
