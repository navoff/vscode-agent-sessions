import { readFile, stat } from "node:fs/promises";

/**
 * Linux dev_t encoding (glibc new_encode_dev), split into the major and
 * minor numbers that /proc/locks prints as "MAJ:MIN:INODE" in hex.
 */
function splitDev(dev: number): { major: number; minor: number } {
  return { major: Math.floor(dev / 256) & 0xfff, minor: (dev & 0xff) | (Math.floor(dev / 4096) & 0xfff00) };
}

/**
 * The pid holding a lock on the file with this device and inode, read from
 * the text of /proc/locks. Undefined when nobody holds one.
 */
export function lockHolderFromProcLocks(procLocks: string, dev: number, ino: number): number | undefined {
  const { major, minor } = splitDev(dev);
  for (const line of procLocks.split("\n")) {
    // "224: FLOCK  ADVISORY  WRITE 601322 fc:01:9966635 0 EOF"; blocked
    // waiters are listed as "224: -> FLOCK ..." and are skipped.
    const fields = line.trim().split(/\s+/);
    if (fields[1] === "->") continue;
    const pid = Number(fields[4]);
    const parts = (fields[5] ?? "").split(":");
    if (parts.length !== 3 || !Number.isInteger(pid)) continue;
    if (parseInt(parts[0], 16) === major && parseInt(parts[1], 16) === minor && Number(parts[2]) === ino) return pid;
  }
  return undefined;
}

/**
 * The pid holding a lock on `file`, or undefined when the file does not
 * exist, nobody holds a lock, or the platform has no /proc/locks.
 */
export async function fileLockHolder(file: string, procLocksPath = "/proc/locks"): Promise<number | undefined> {
  let st;
  let text: string;
  try {
    st = await stat(file);
    text = await readFile(procLocksPath, "utf8");
  } catch {
    return undefined;
  }
  return lockHolderFromProcLocks(text, st.dev, st.ino);
}
