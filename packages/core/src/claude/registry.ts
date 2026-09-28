import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ClaudeLiveEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  status: "busy" | "idle";
  updatedAt: number;
  statusUpdatedAt: number;
}

export function parseClaudeLiveEntry(text: string): ClaudeLiveEntry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.pid !== "number" || typeof r.sessionId !== "string") return undefined;
  const status = r.status === "busy" ? "busy" : r.status === "idle" ? "idle" : undefined;
  if (!status) return undefined;
  return {
    pid: r.pid,
    sessionId: r.sessionId,
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    status,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    statusUpdatedAt: typeof r.statusUpdatedAt === "number" ? r.statusUpdatedAt : 0,
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readClaudeRegistry(
  sessionsDir: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<Map<string, ClaudeLiveEntry>> {
  const result = new Map<string, ClaudeLiveEntry>();
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let text: string;
    try {
      text = await readFile(join(sessionsDir, name), "utf8");
    } catch {
      continue;
    }
    const entry = parseClaudeLiveEntry(text);
    if (!entry || !isAlive(entry.pid)) continue;
    const prev = result.get(entry.sessionId);
    if (!prev || prev.updatedAt < entry.updatedAt) result.set(entry.sessionId, entry);
  }
  return result;
}
