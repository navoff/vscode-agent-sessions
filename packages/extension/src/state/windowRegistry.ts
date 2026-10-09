import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every local window records its folders in `<dir>/<pid>.json`, keyed by the
 * pid of its extension host, so another window can tell which window has a
 * folder open. `vscode.openFolder` brings an existing window to the front only
 * for its exact target: the folder of a single-folder window or the
 * `.code-workspace` file of a multi-root one.
 */
export interface WindowRecord {
  pid: number;
  /** The workspace file of a multi-root window, absent for a single-folder one. */
  workspaceFile?: string;
  folders: string[];
  updatedAt: number;
}

/** A record not rewritten for this long is ignored: its pid may belong to another process by now. */
export const WINDOW_RECORD_MAX_AGE_MS = 7 * 24 * 3600_000;

/** Writes the record of a window; readers never see a partial file. */
export async function writeWindowRecord(dir: string, record: WindowRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${record.pid}.json`);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function removeWindowRecord(dir: string, pid: number): Promise<void> {
  try {
    await unlink(join(dir, `${pid}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function parseRecord(text: string): WindowRecord | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const { pid, workspaceFile, folders, updatedAt } = v as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof updatedAt !== "number") return undefined;
  if (!Array.isArray(folders) || !folders.every((f) => typeof f === "string")) return undefined;
  if (workspaceFile !== undefined && typeof workspaceFile !== "string") return undefined;
  return { pid, folders, updatedAt, ...(workspaceFile ? { workspaceFile } : {}) };
}

export interface FindWindowOptions {
  isAlive(pid: number): boolean;
  canonical(p: string): Promise<string>;
  now: number;
}

/**
 * The live window that has `cwd` as its first folder, the one Claude Code
 * runs in; the other folders of a multi-root window do not count. A
 * multi-root window wins over a single-folder one, then the most recently
 * updated record. Records of dead windows are deleted on the way.
 */
export async function findWindowForFolder(dir: string, cwd: string, opts: FindWindowOptions): Promise<WindowRecord | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const target = await opts.canonical(cwd);
  const matches: WindowRecord[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(dir, name);
    const text = await readFile(path, "utf8").catch(() => undefined);
    const record = text === undefined ? undefined : parseRecord(text);
    if (!record) continue;
    if (!opts.isAlive(record.pid)) {
      await unlink(path).catch(() => undefined);
      continue;
    }
    if (opts.now - record.updatedAt > WINDOW_RECORD_MAX_AGE_MS) continue;
    const first = record.folders[0];
    if (first !== undefined && (await opts.canonical(first)) === target) matches.push(record);
  }
  matches.sort((a, b) => Number(!!b.workspaceFile) - Number(!!a.workspaceFile) || b.updatedAt - a.updatedAt || a.pid - b.pid);
  return matches[0];
}

/** The path to hand to `vscode.openFolder` to bring the window of `record` to the front. */
export function windowRecordTarget(record: WindowRecord, cwd: string): string {
  return record.workspaceFile ?? cwd;
}
