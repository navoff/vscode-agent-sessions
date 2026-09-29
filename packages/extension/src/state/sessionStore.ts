import { sessionKey, type SessionInfo } from "@agent-sessions/core";
import { markKey, type SessionMarks } from "./marks.js";

// Session ids come from files and end up in terminal commands and URIs.
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

export interface SessionRow {
  machineId: string;
  session: SessionInfo;
  hidden: boolean;
  unread: boolean;
}

export class SessionStore {
  private readonly byMachine = new Map<string, Map<string, SessionInfo>>();

  constructor(private readonly marks: SessionMarks) {}

  setMachineSessions(machineId: string, sessions: Map<string, SessionInfo>): void {
    for (const s of sessions.values()) {
      const key = markKey(machineId, s);
      if (this.marks.lastSeen(key) === undefined) this.marks.setLastSeen(key, s.updatedAt);
    }
    this.byMachine.set(machineId, new Map(sessions));
  }

  removeMachine(machineId: string): void {
    this.byMachine.delete(machineId);
  }

  machineIds(): string[] {
    return [...this.byMachine.keys()];
  }

  find(machineId: string, key: string): SessionInfo | undefined {
    return this.byMachine.get(machineId)?.get(key);
  }

  rows(machineId: string): SessionRow[] {
    const sessions = this.byMachine.get(machineId);
    if (!sessions) return [];
    return [...sessions.values()].map((session) => {
      const key = markKey(machineId, session);
      return { machineId, session, hidden: this.marks.isHidden(key), unread: this.isUnread(key, session) };
    });
  }

  markRead(machineId: string, session: SessionInfo, now: number): void {
    this.marks.setLastSeen(markKey(machineId, session), now);
  }

  markUnread(machineId: string, session: SessionInfo): void {
    this.marks.setLastSeen(markKey(machineId, session), session.updatedAt - 1);
  }

  setHidden(machineId: string, session: SessionInfo, hidden: boolean): void {
    this.marks.setHidden(markKey(machineId, session), hidden);
  }

  isProjectHidden(machineId: string, cwd: string): boolean {
    return this.marks.isProjectHidden(machineId, cwd);
  }

  setProjectHidden(machineId: string, cwd: string, hidden: boolean): void {
    this.marks.setProjectHidden(machineId, cwd, hidden);
  }

  /** Forgets the hidden and last-seen marks of a deleted session. */
  forget(machineId: string, session: Pick<SessionInfo, "agent" | "id">): void {
    this.marks.forget(markKey(machineId, session));
  }

  private isUnread(key: string, session: SessionInfo): boolean {
    if (session.status === "running") return false;
    const seen = this.marks.lastSeen(key);
    return seen !== undefined && session.updatedAt > seen;
  }
}

export { sessionKey };
