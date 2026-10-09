import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CLAIM_MAX_AGE_MS = 7 * 24 * 3600_000;

/**
 * Claims the notification about session `key` at `updatedAt` for this window.
 * Every window of the machine decides on the same sessions at about the same
 * time; creating the claim file is atomic, so exactly one of them gets true.
 */
export async function claimNotification(dir: string, key: string, updatedAt: number): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const name = `${createHash("sha1").update(key).digest("hex")}-${updatedAt}`;
  try {
    await writeFile(join(dir, name), "", { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Deletes claim files older than `maxAgeMs`; returns how many. A missing directory has none. */
export async function pruneNotifyClaims(dir: string, now: number, maxAgeMs: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{40}-/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - (await stat(path)).mtimeMs <= maxAgeMs) continue;
      await unlink(path);
      removed++;
    } catch (err) {
      // another window pruned it first
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return removed;
}
