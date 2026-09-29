export type AgentKind = "claude" | "codex" | "opencode";
export type SessionStatus = "running" | "idle" | "unknown";

export interface SessionLiveInfo {
  pid: number;
  statusUpdatedAt: number;
}

export interface SessionInfo {
  agent: AgentKind;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  live?: SessionLiveInfo;
}

export function sessionKey(s: Pick<SessionInfo, "agent" | "id">): string {
  return `${s.agent}:${s.id}`;
}

export interface Disposable {
  dispose(): void;
}

export interface SessionProvider {
  readonly agent: AgentKind;
  snapshot(): Promise<SessionInfo[]>;
  watch(onChange: () => void): Disposable;
  /** Permanently deletes a session with the agent's own mechanism; rejects with a readable error. */
  delete?(id: string): Promise<void>;
}
