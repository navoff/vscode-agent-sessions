import { spawn } from "node:child_process";
import type { DaemonProcess } from "./machineConnection.js";

export function spawnLocalDaemon(daemonPath: string, log: (line: string) => void): DaemonProcess {
  const child = spawn(process.execPath, [daemonPath, "--stdio"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => log(`[local] ${String(d).trimEnd()}`));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => {
      child.kill();
    },
    onExit: (cb) => {
      child.on("exit", (code) => cb(code));
      child.on("error", (err) => {
        log(`[local] spawn error: ${String(err)}`);
        cb(null);
      });
    },
  };
}
