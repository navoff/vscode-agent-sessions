/** How far back the tabs in front of the user are remembered. */
const HISTORY_MS = 30 * 60_000;

export interface CodexThread {
  id: string;
  createdAt: number;
}

/**
 * Which thread a Codex new-chat tab shows. Such a tab keeps its
 * `/extension/panel/new` resource and its "Codex" label after its chat
 * becomes a thread, and Codex tells no one which thread that is. A thread is
 * created when its first message is sent, from the tab in front of the user,
 * so it belongs to the new-chat tab that was active in this focused window at
 * its creation. Tabs are named by their resource, which is distinct for each
 * open tab.
 */
export class CodexTabTracker {
  /** From `at` on, `tab` was the new-chat tab in front of the user, or none was. */
  private history: { at: number; tab: string | undefined }[] = [];
  /** When each open new-chat tab was first seen; threads older than that are not its. */
  private readonly opened = new Map<string, number>();
  private readonly bound = new Map<string, CodexThread>();

  /** Records the new-chat tab in front of the user from `at` on; undefined when there is none or the window is not focused. */
  noteActive(at: number, tab: string | undefined): void {
    if (tab !== undefined && !this.opened.has(tab)) this.opened.set(tab, at);
    if (this.history.at(-1)?.tab === tab && this.history.length > 0) return;
    this.history.push({ at, tab });
  }

  /**
   * Binds each open new-chat tab to the newest thread created while it was in
   * front; `open` are the new-chat tabs open now. True when a binding changed.
   */
  update(threads: readonly CodexThread[], open: ReadonlySet<string>, now: number): boolean {
    for (const tab of [...this.opened.keys()]) if (!open.has(tab)) this.opened.delete(tab);
    for (const tab of open) if (!this.opened.has(tab)) this.opened.set(tab, now);
    this.prune(now);
    const before = new Map(this.bound);
    for (const tab of [...this.bound.keys()]) if (!open.has(tab)) this.bound.delete(tab);
    for (const thread of threads) {
      const tab = this.activeAt(thread.createdAt);
      if (tab === undefined || thread.createdAt < (this.opened.get(tab) ?? Infinity)) continue;
      const current = this.bound.get(tab);
      if (!current || current.createdAt < thread.createdAt) this.bound.set(tab, thread);
    }
    if (before.size !== this.bound.size) return true;
    for (const [tab, thread] of this.bound) if (before.get(tab)?.id !== thread.id) return true;
    return false;
  }

  /** The thread a new-chat tab shows, if known. */
  sessionOf(tab: string): string | undefined {
    return this.bound.get(tab)?.id;
  }

  /** The new-chat tab that shows a thread, if any. */
  tabOf(sessionId: string): string | undefined {
    for (const [tab, thread] of this.bound) if (thread.id === sessionId) return tab;
    return undefined;
  }

  private activeAt(t: number): string | undefined {
    let tab: string | undefined;
    for (const entry of this.history) {
      if (entry.at > t) break;
      tab = entry.tab;
    }
    return tab;
  }

  /** Drops entries older than HISTORY_MS, keeping the one that was current at the cut. */
  private prune(now: number): void {
    const cut = now - HISTORY_MS;
    let first = 0;
    while (first + 1 < this.history.length && this.history[first + 1].at <= cut) first++;
    if (first > 0) this.history = this.history.slice(first);
  }
}
