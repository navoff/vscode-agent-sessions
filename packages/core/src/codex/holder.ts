import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionClient } from "../types.js";
import { fileLockHolder } from "../util/fileLock.js";

/** The writer lock file of a thread. */
export function codexThreadLockPath(codexDir: string, id: string): string {
  return join(codexDir, "thread-writer-locks", `${id.toLowerCase()}.lock`);
}

/**
 * A Codex process that has a thread loaded (the app-server of the VS Code
 * plugin, a TUI) holds the thread's writer lock, so the thread cannot be
 * deleted or moved meanwhile. The VS Code plugin keeps a thread loaded
 * until its window reloads, or for hours after its last tab is closed.
 */
export async function codexThreadHolder(codexDir: string, id: string, procLocksPath?: string): Promise<number | undefined> {
  return fileLockHolder(codexThreadLockPath(codexDir, id), procLocksPath);
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

/**
 * Whether the Codex process run from `argv0` is the app-server of the Codex
 * extension of VS Code, which lives in the extensions folder of VS Code or
 * of its Remote-SSH server. A TUI or Codex's own background app-server is not.
 */
export function codexClientOfCommand(argv0: string): SessionClient {
  return argv0.includes("/extensions/openai.chatgpt-") ? "vscode" : "other";
}

/** Whether the client that started a thread is the VS Code extension; undefined without one. */
export function codexClientOfOriginator(originator: string | undefined): SessionClient | undefined {
  if (!originator) return undefined;
  return originator === "codex_vscode" ? "vscode" : "other";
}

/** The command line of a process, from /proc; undefined when it is gone or there is no /proc. */
export async function procCmdline(pid: number): Promise<string[] | undefined> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter((a) => a !== "");
  } catch {
    return undefined;
  }
}
