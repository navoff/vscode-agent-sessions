import { spawn } from "node:child_process";
import { createStderrTail, type DaemonProcess } from "./machineConnection.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// RemoteCommand=none and RequestTTY=no override ssh_config entries that force
// an interactive shell (RemoteCommand zsh, RequestTTY yes); with them set, ssh
// refuses to run our command ("Cannot execute command-line and remote command").
export const SSH_BASE_ARGS = [
  "-o", "BatchMode=yes",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  "-o", "ConnectTimeout=15",
  "-o", "RemoteCommand=none",
  "-o", "RequestTTY=no",
];

export function spawnSshDaemon(sshPath: string, sshHost: string, remoteNode: string, remoteDaemon: string, log: (line: string) => void): DaemonProcess {
  const child = spawn(sshPath, [...SSH_BASE_ARGS, "-T", "--", sshHost, `${shellQuote(remoteNode)} ${shellQuote(remoteDaemon)} --stdio`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderrTail = createStderrTail();
  child.stderr.on("data", (d) => {
    stderrTail.push(d);
    log(`[${sshHost}] ${String(d).trimEnd()}`);
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => {
      child.kill();
    },
    lastStderr: () => stderrTail.text(),
    onExit: (cb) => {
      // "close" fires after stderr is drained, so lastStderr() is complete.
      child.on("close", (code) => cb(code));
      child.on("error", (err) => {
        log(`[${sshHost}] spawn error: ${String(err)}`);
        cb(null);
      });
    },
  };
}
