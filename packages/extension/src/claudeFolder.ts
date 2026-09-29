import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import type { SessionInfo } from "@agent-sessions/core";

/**
 * The Claude Code extension looks a session up only in the project folders
 * of the window folder and of its git worktrees; any other id opens as an
 * empty conversation. These helpers decide whether a session is reachable
 * and hand an unreachable one over to a window opened on its folder.
 */

async function canonical(path: string): Promise<string> {
  const p = await realpath(path).catch(() => path);
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** Paths of the git worktrees of the repository at `dir`, or none outside git. */
export function gitWorktrees(dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["worktree", "list", "--porcelain"], { cwd: dir, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split("\n").flatMap((l) => (l.startsWith("worktree ") ? [l.slice("worktree ".length)] : [])));
    });
  });
}

/** Whether Claude Code in a window on `folders` finds a session started in `cwd`. */
export async function claudeFindsSession(cwd: string, folders: readonly string[], worktrees = gitWorktrees): Promise<boolean> {
  // Without a cwd there is nothing to compare; let Claude Code try.
  if (!cwd) return true;
  const target = await canonical(cwd);
  for (const folder of folders) {
    if ((await canonical(folder)) === target) return true;
    for (const w of await worktrees(folder)) if ((await canonical(w)) === target) return true;
  }
  return false;
}

export async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

/** A session to open once a window on its folder activates. */
export interface PendingOpen {
  session: SessionInfo;
  at: number;
}

export const PENDING_OPEN_KEY = "agentSessions.pendingClaudeOpen";
/** A new window that takes longer than this to activate does not pick the session up. */
export const PENDING_OPEN_TTL_MS = 2 * 60_000;

/** The pending session this window should open, if it is fresh and the window is on its folder. */
export async function pendingSessionFor(pending: PendingOpen | undefined, folders: readonly string[], now: number): Promise<SessionInfo | undefined> {
  if (!pending?.session?.cwd || typeof pending.at !== "number") return undefined;
  if (now - pending.at > PENDING_OPEN_TTL_MS || now < pending.at) return undefined;
  const target = await canonical(pending.session.cwd);
  for (const f of folders) if ((await canonical(f)) === target) return pending.session;
  return undefined;
}
