import type { AgentKind, SessionInfo } from "@agent-sessions/core";

export const PROTOCOL_VERSION = 1;

export type ClientMessage =
  | { type: "hello"; protocol: number }
  | { type: "snapshot" }
  | { type: "ping" };

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
  | { type: "error"; message: string };

export function parseClientMessage(line: string): ClientMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { type?: unknown; protocol?: unknown };
  switch (r.type) {
    case "hello":
      return typeof r.protocol === "number" ? { type: "hello", protocol: r.protocol } : undefined;
    case "snapshot":
      return { type: "snapshot" };
    case "ping":
      return { type: "ping" };
    default:
      return undefined;
  }
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
      return Array.isArray(r.sessions) ? { type: "snapshot", sessions: r.sessions as SessionInfo[] } : undefined;
    case "changed":
      return Array.isArray(r.upserted) && Array.isArray(r.removed)
        ? { type: "changed", upserted: r.upserted as SessionInfo[], removed: r.removed as string[] }
        : undefined;
    case "pong":
      return { type: "pong" };
    case "error":
      return { type: "error", message: typeof r.message === "string" ? r.message : "unknown error" };
    default:
      return undefined;
  }
}
