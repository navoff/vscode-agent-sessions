import { sessionKey, type SessionInfo } from "@agent-sessions/core";

type Thenable<T> = Promise<T> | PromiseLike<T>;

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

export function markKey(machineId: string, session: Pick<SessionInfo, "agent" | "id">): string {
  return `${machineId}/${sessionKey(session)}`;
}

export class SessionMarks {
  constructor(private readonly store: KeyValueStore) {}

  isHidden(key: string): boolean {
    return this.store.get<boolean>(`hidden/${key}`) === true;
  }

  setHidden(key: string, hidden: boolean): void {
    void this.store.update(`hidden/${key}`, hidden ? true : undefined);
  }

  /** A folder hidden as a whole; independent of the hidden marks of its sessions. */
  isProjectHidden(machineId: string, cwd: string): boolean {
    return this.store.get<boolean>(`hiddenProject/${machineId}/${cwd}`) === true;
  }

  setProjectHidden(machineId: string, cwd: string, hidden: boolean): void {
    void this.store.update(`hiddenProject/${machineId}/${cwd}`, hidden ? true : undefined);
  }

  lastSeen(key: string): number | undefined {
    const v = this.store.get<number>(`seen/${key}`);
    return typeof v === "number" ? v : undefined;
  }

  setLastSeen(key: string, ts: number): void {
    void this.store.update(`seen/${key}`, ts);
  }

  /** Drops every mark of a session, such as after it was deleted. */
  forget(key: string): void {
    void this.store.update(`hidden/${key}`, undefined);
    void this.store.update(`seen/${key}`, undefined);
  }
}
