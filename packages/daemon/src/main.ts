import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider, CodexProvider } from "@agent-sessions/core";
import { Daemon } from "./daemon.js";
import { parseClientMessage, type DaemonMessage } from "./protocol.js";

declare const __DAEMON_VERSION__: string | undefined;
const VERSION = typeof __DAEMON_VERSION__ === "string" ? __DAEMON_VERSION__ : "0.0.0-dev";

// On stdin close we must let any in-flight refresh (triggered by a "snapshot"
// message) land before stopping the daemon and exiting, otherwise the reply can
// be dropped silently. EXIT_GRACE_MS caps how long we wait for a stuck provider
// before exiting anyway; stop() only runs after the wait, since stopping first
// would suppress the pending send.
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
  const send = (m: DaemonMessage) => {
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
    daemon.handle(msg);
  });
  rl.on("close", () => {
    void Promise.race([daemon.drain(), new Promise<void>((r) => setTimeout(r, EXIT_GRACE_MS).unref())]).then(() => {
      daemon.stop();
      process.exit(0);
    });
  });
}

main(process.argv.slice(2));
