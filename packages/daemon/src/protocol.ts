import type { AgentKind, SessionInfo } from "@agent-sessions/core";

/** 2 added "delete" and "deleteResult"; 3 added "pendingOpen" and "pendingOpenResult". */
export const PROTOCOL_VERSION = 3;

export type ClientMessage =
  | { type: "hello"; protocol: number }
  | { type: "snapshot" }
  | { type: "ping" }
  | { type: "shutdown" }
  /** Permanently deletes a session; answered by "deleteResult" with the same requestId. */
  | { type: "delete"; requestId: string; agent: string; id: string }
  /** Records a session for a window on its folder to open; answered by "pendingOpenResult". */
  | { type: "pendingOpen"; requestId: string; session: SessionInfo };

export interface HelloInfo {
  protocol: number;
  daemonVersion: string;
  agents: AgentKind[];
  home: string;
}

export type DaemonMessage =
  | ({ type: "hello" } & HelloInfo)
  | { type: "snapshot"; sessions: SessionInfo[] }
  | { type: "changed"; upserted: SessionInfo[]; removed: string[] }
  | { type: "pong" }
  | { type: "deleteResult"; requestId: string; ok: boolean; error?: string }
  | { type: "pendingOpenResult"; requestId: string; ok: boolean; error?: string }
  | { type: "error"; message: string };

export function parseClientMessage(line: string): ClientMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "hello":
      return typeof r.protocol === "number" ? { type: "hello", protocol: r.protocol } : undefined;
    case "snapshot":
      return { type: "snapshot" };
    case "ping":
      return { type: "ping" };
    case "shutdown":
      return { type: "shutdown" };
    case "delete":
      return typeof r.requestId === "string" && typeof r.agent === "string" && typeof r.id === "string"
        ? { type: "delete", requestId: r.requestId, agent: r.agent, id: r.id }
        : undefined;
    case "pendingOpen":
      return typeof r.requestId === "string" && isSessionInfo(r.session)
        ? { type: "pendingOpen", requestId: r.requestId, session: r.session }
        : undefined;
    default:
      return undefined;
  }
}

const STATUSES = new Set<unknown>(["running", "idle", "unknown"]);

export function isSessionInfo(v: unknown): v is SessionInfo {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.agent === "string" &&
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    typeof s.cwd === "string" &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number" &&
    STATUSES.has(s.status)
  );
}

export function parseDaemonMessage(line: string): DaemonMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "hello":
      return typeof r.protocol === "number" && typeof r.daemonVersion === "string" && Array.isArray(r.agents) && typeof r.home === "string"
        ? { type: "hello", protocol: r.protocol, daemonVersion: r.daemonVersion, agents: r.agents as AgentKind[], home: r.home }
        : undefined;
    case "snapshot":
      return Array.isArray(r.sessions) ? { type: "snapshot", sessions: r.sessions.filter(isSessionInfo) } : undefined;
    case "changed":
      return Array.isArray(r.upserted) && Array.isArray(r.removed)
        ? { type: "changed", upserted: r.upserted.filter(isSessionInfo), removed: r.removed.filter((k): k is string => typeof k === "string") }
        : undefined;
    case "pong":
      return { type: "pong" };
    case "deleteResult": {
      if (typeof r.requestId !== "string" || typeof r.ok !== "boolean") return undefined;
      const msg: DaemonMessage = { type: "deleteResult", requestId: r.requestId, ok: r.ok };
      if (typeof r.error === "string") msg.error = r.error;
      return msg;
    }
    case "pendingOpenResult": {
      if (typeof r.requestId !== "string" || typeof r.ok !== "boolean") return undefined;
      const msg: DaemonMessage = { type: "pendingOpenResult", requestId: r.requestId, ok: r.ok };
      if (typeof r.error === "string") msg.error = r.error;
      return msg;
    }
    case "error":
      return { type: "error", message: typeof r.message === "string" ? r.message : "unknown error" };
    default:
      return undefined;
  }
}
