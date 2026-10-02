import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** The parent pid in the text of /proc/<pid>/stat: `pid (command) state ppid ...`. */
export function parentPidFromStat(stat: string): number | undefined {
  // The command may hold spaces and parentheses, so read past its last one.
  const m = /^\) \S (\d+)/.exec(stat.slice(stat.lastIndexOf(")")));
  return m ? Number(m[1]) : undefined;
}

/** The parent of process `pid`; undefined when it is gone or cannot be told on this platform. */
export async function parentPid(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    try {
      return parentPidFromStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") return undefined;
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 2000 }, (err, stdout) => {
      const ppid = Number(stdout.trim());
      resolve(!err && Number.isInteger(ppid) && ppid > 0 ? ppid : undefined);
    });
  });
}
