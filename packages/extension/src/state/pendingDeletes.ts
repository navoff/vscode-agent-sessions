/**
 * Codex sessions to delete once this window has reloaded: the reload ends
 * the Codex app-server that kept them loaded, and with it their writer
 * locks. Kept in the workspace state of the window across the reload.
 */
export const PENDING_DELETES_KEY = "agentSessions.pendingCodexDeletes";

/** A record older than this was left by a reload that did not happen, or failed. */
export const PENDING_DELETES_MAX_AGE_MS = 2 * 60_000;

export interface PendingDeletes {
  ids: string[];
  at: number;
}

/** The session ids of a stored record that are still due at `now`; none for anything else. */
export function duePendingDeletes(stored: unknown, now: number): string[] {
  if (typeof stored !== "object" || stored === null) return [];
  const { ids, at } = stored as Record<string, unknown>;
  if (typeof at !== "number" || now - at > PENDING_DELETES_MAX_AGE_MS || now < at) return [];
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string");
}
