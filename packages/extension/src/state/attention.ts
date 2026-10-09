import { markKey, type SessionMarks } from "./marks.js";
import type { SessionRow } from "./sessionStore.js";

/**
 * How long a window waits after the attention set gains a session before it
 * decides on notifications: by then the marks other windows wrote (a session
 * read in the focused window, one announced elsewhere) have reached it.
 * globalState takes a few hundred milliseconds to cross windows; the rest of
 * the delay the user sees is the daemon noticing the session file change.
 */
export const NOTIFY_SETTLE_MS = 600;

/** More fresh sessions than this at once are announced with one summary. */
export const BURST_LIMIT = 3;

const MAX_TOAST_TITLE = 80;

/**
 * Sessions that finished work and wait for the user: unread, not running, not
 * hidden, not in a hidden folder, on any machine. The view filter does not apply: it is
 * about what the user is looking at, not about what is waiting. Newest first.
 */
export function attentionRows(rowsByMachine: Map<string, SessionRow[]>, isProjectHidden: (machineId: string, cwd: string) => boolean): SessionRow[] {
  const out: SessionRow[] = [];
  for (const rows of rowsByMachine.values()) {
    for (const r of rows) if (r.unread && r.session.status !== "running" && !r.hidden && !isProjectHidden(r.machineId, r.session.cwd)) out.push(r);
  }
  return out.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
}

/** The badge of the view container; none when nothing waits. */
export function attentionBadge(count: number): { value: number; tooltip: string } | undefined {
  if (count <= 0) return undefined;
  return { value: count, tooltip: count === 1 ? "1 session needs attention" : `${count} sessions need attention` };
}

/** The updatedAt of every waiting session, by mark key. */
export function attentionSnapshot(rows: readonly SessionRow[]): Map<string, number> {
  return new Map(rows.map((r) => [markKey(r.machineId, r.session), r.session.updatedAt]));
}

/** Whether `rows` has a session that `prev` (an attentionSnapshot) lacks, or one with more activity since. */
export function gainedAttention(prev: ReadonlyMap<string, number>, rows: readonly SessionRow[]): boolean {
  return rows.some((r) => {
    const before = prev.get(markKey(r.machineId, r.session));
    return before === undefined || r.session.updatedAt > before;
  });
}

export type NotificationPlan = { kind: "each"; rows: SessionRow[] } | { kind: "summary"; count: number };

/** One notification per fresh session, or a single summary when more than BURST_LIMIT arrive at once. */
export function notificationPlan(fresh: SessionRow[]): NotificationPlan {
  return fresh.length > BURST_LIMIT ? { kind: "summary", count: fresh.length } : { kind: "each", rows: fresh };
}

export function burstTitle(count: number): string {
  return `${count} sessions need attention`;
}

/**
 * The text of a VS Code message about a session. Brackets go, since the
 * message renders `[text](link)` as a link; a long title is shortened.
 */
export function toastText(title: string, where: string): string {
  const strip = (s: string) => s.replace(/[\[\]]/g, "");
  const chars = [...strip(title)];
  const short = chars.length > MAX_TOAST_TITLE ? chars.slice(0, MAX_TOAST_TITLE - 1).join("") + "…" : chars.join("");
  return `${short} (${strip(where)})`;
}

/**
 * Decides which waiting sessions to notify about. Every VS Code window sees
 * the same sessions; the `notified/` marks in globalState are a fast filter,
 * a claim file (see claimNotification) settles which window announces.
 */
export class AttentionTracker {
  constructor(private readonly marks: SessionMarks) {}

  /**
   * Once per installation: records every session waiting now as announced, so
   * that the first run with notifications does not announce the backlog.
   * True when it did so.
   */
  seedIfNeeded(attention: readonly SessionRow[]): boolean {
    if (this.marks.isNotifySeeded()) return false;
    for (const r of attention) this.marks.setLastNotified(markKey(r.machineId, r.session), r.session.updatedAt);
    this.marks.setNotifySeeded();
    return true;
  }

  /** The rows of `attention` not yet announced at their current updatedAt; records them as announced. */
  toNotify(attention: readonly SessionRow[]): SessionRow[] {
    const out: SessionRow[] = [];
    for (const r of attention) {
      const key = markKey(r.machineId, r.session);
      const last = this.marks.lastNotified(key);
      if (last !== undefined && last >= r.session.updatedAt) continue;
      this.marks.setLastNotified(key, r.session.updatedAt);
      out.push(r);
    }
    return out;
  }
}
