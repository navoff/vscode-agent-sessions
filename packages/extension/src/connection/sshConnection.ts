import { spawn } from "node:child_process";
import type { DaemonProcess } from "./machineConnection.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const SSH_BASE_ARGS = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=15"];

export function spawnSshDaemon(sshPath: string, sshHost: string, remoteNode: string, remoteDaemon: string, log: (line: string) => void): DaemonProcess {
  const child = spawn(sshPath, [...SSH_BASE_ARGS, "-T", "--", sshHost, `${shellQuote(remoteNode)} ${shellQuote(remoteDaemon)} --stdio`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => log(`[${sshHost}] ${String(d).trimEnd()}`));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => {
      child.kill();
    },
    onExit: (cb) => {
      child.on("exit", (code) => cb(code));
      child.on("error", (err) => {
        log(`[${sshHost}] spawn error: ${String(err)}`);
        cb(null);
      });
    },
  };
}
