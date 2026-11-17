import { join } from "node:path";
import { fileLockHolder } from "../util/fileLock.js";

/**
 * A Codex process that has a thread loaded (the app-server of the VS Code
 * plugin, a TUI) holds the thread's writer lock, so the thread cannot be
 * deleted or moved meanwhile. The VS Code plugin keeps a thread loaded
 * until its window reloads, or for hours after its last tab is closed.
 */
export async function codexThreadHolder(codexDir: string, id: string, procLocksPath?: string): Promise<number | undefined> {
  return fileLockHolder(join(codexDir, "thread-writer-locks", `${id.toLowerCase()}.lock`), procLocksPath);
}

/** The error for a thread whose writer lock process `pid` holds; `codexHolderFromError` reads the pid back. */
export function codexHeldError(pid: number): string {
  return `the session is open in Codex (process ${pid}). Codex lets it go when the VS Code window that has it open reloads, or about 3 hours after its last tab there is closed`;
}

/** The pid named by an error of `codexHeldError`, if `message` is one. */
export function codexHolderFromError(message: string): number | undefined {
  const m = /open in Codex \(process (\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}
