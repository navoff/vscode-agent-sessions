import { spawn } from "node:child_process";
import type { SshResult, SshRunner } from "../machines/prepare.js";
import { SSH_BASE_ARGS } from "./sshConnection.js";

export function createSshRunner(sshPath: string, log: (line: string) => void): SshRunner {
  return {
    run(host: string, command: string, stdin?: string): Promise<SshResult> {
      log(`[${host}] $ ${command.length > 200 ? command.slice(0, 200) + "…" : command}`);
      return new Promise((resolve) => {
        const child = spawn(sshPath, [...SSH_BASE_ARGS, "-T", host, command], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => resolve({ code: 255, stdout, stderr: `${stderr}${String(err)}` }));
        child.on("close", (code) => resolve({ code: code ?? 255, stdout, stderr }));
        child.stdin.on("error", () => {});
        child.stdin.end(stdin ?? "");
      });
    },
  };
}
