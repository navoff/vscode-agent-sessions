import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionInfo } from "@agent-sessions/core";
import { isSessionInfo } from "./protocol.js";

/**
 * A session that a window on its folder should open. Written on the
 * machine that holds the session, by its daemon, and read by the extension
 * of a window that opens on that machine.
 */
export interface PendingOpen {
  session: SessionInfo;
  at: number;
}

/** Fixed under home: the ssh daemon runs without XDG_RUNTIME_DIR, the extension host may have it. */
export function pendingOpenPath(home: string): string {
  return join(home, ".local", "share", "agent-sessions", "pending-open.json");
}

export async function writePendingOpen(home: string, session: SessionInfo, now: number): Promise<void> {
  const st = await stat(session.cwd).catch(() => undefined);
  if (!st?.isDirectory()) throw new Error(`${session.cwd} does not exist`);
  const path = pendingOpenPath(home);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const entry: PendingOpen = { session, at: now };
  await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
  await rename(tmp, path);
}

export async function readPendingOpen(home: string): Promise<PendingOpen | undefined> {
  const text = await readFile(pendingOpenPath(home), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isSessionInfo(r.session) || typeof r.at !== "number") return undefined;
  return { session: r.session, at: r.at };
}

export async function clearPendingOpen(home: string): Promise<void> {
  await rm(pendingOpenPath(home), { force: true });
}
