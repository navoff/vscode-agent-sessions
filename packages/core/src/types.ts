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
  /** Start of the first user message, line breaks kept; shown in the session tooltip. */
  firstPrompt?: string;
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
  /** Renames a session with the agent's own mechanism; rejects with a readable error. */
  rename?(id: string, title: string): Promise<void>;
  /** Moves a session to the folder `cwd` of the same machine; rejects with a readable error. */
  move?(id: string, cwd: string): Promise<void>;
}
