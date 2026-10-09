import { spawn as spawnProcess } from "node:child_process";
import { createConnection } from "node:net";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ensurePrivateDir } from "../connection/sharedDaemon.js";
import type { TrayClientOptions, TraySocket } from "./trayClient.js";

/** Makes `binary` executable in place, or as a copy under `fallbackDir`; returns the path to run. */
export async function executableTray(binary: string, fallbackDir: string): Promise<string> {
  try {
    await chmod(binary, 0o755);
    return binary;
  } catch {
    const copy = join(fallbackDir, basename(binary));
    await mkdir(fallbackDir, { recursive: true });
    await copyFile(binary, copy);
    await chmod(copy, 0o755);
    return copy;
  }
}

export function nodeTrayIo(fallbackDir: string, log: (line: string) => void): Pick<TrayClientOptions, "connect" | "spawn"> {
  let spawnErrorLogged = false;
  return {
    connect: (path) =>
      new Promise<TraySocket>((resolve, reject) => {
        const sock = createConnection(path);
        sock.once("connect", () => {
          sock.removeListener("error", reject);
          sock.setEncoding("utf8");
          sock.on("error", (err) => log(`[tray] socket error: ${String(err)}`));
          const closeCbs: (() => void)[] = [];
          sock.on("close", () => closeCbs.forEach((cb) => cb()));
          resolve({
            write: (line) => void sock.write(line),
            onClose: (cb) => void closeCbs.push(cb),
            end: () => sock.end(),
          });
        });
        sock.once("error", reject);
      }),
    spawn: async (binary, socketPath) => {
      const exe = await executableTray(binary, fallbackDir);
      // The helper refuses a directory that other users could write to as well.
      await ensurePrivateDir(dirname(socketPath));
      const child = spawnProcess(exe, ["--socket", socketPath], { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        if (spawnErrorLogged) return;
        spawnErrorLogged = true;
        log(`[tray] helper failed to start: ${String(err)}`);
      });
      child.unref();
    },
  };
}
