import type { AgentKind } from "@agent-sessions/core";
import type { MachineState } from "../connection/machineConnection.js";
import type { SessionRow } from "../state/sessionStore.js";

export interface TreeFilter {
  agents: Set<AgentKind> | undefined;
  showRemote: boolean;
  workspaceOnly: boolean;
  showHidden: boolean;
}

export interface MachineInput {
  id: string;
  name: string;
  isLocal: boolean;
  state: MachineState;
  error?: string;
  home?: string; // remote machine home directory, from the daemon hello
}

export interface SessionNode {
  kind: "session";
  machineId: string;
  row: SessionRow;
}

export interface ProjectNode {
  kind: "project";
  machineId: string;
  cwd: string;
  label: string;
  sessions: SessionNode[];
}

export interface MachineNode {
  kind: "machine";
  machine: MachineInput;
  projects: ProjectNode[];
}

export type TreeNode = MachineNode | ProjectNode | SessionNode;

export interface BuildOptions {
  home: string;
  workspaceFolders: string[];
}

export function shortenCwd(cwd: string, home: string): string {
  if (!cwd) return "(no folder)";
  if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
  return cwd;
}

export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function sessionDescription(row: SessionRow, now: number): string {
  const parts: string[] = [];
  if (row.hidden) parts.push("hidden");
  if (row.session.status === "running") parts.push("● running");
  else parts.push(relativeTime(row.session.updatedAt, now));
  return parts.join(" · ");
}

export function sessionIconName(row: SessionRow): string {
  if (row.hidden) return `${row.session.agent}-hidden`;
  if (row.unread) return `${row.session.agent}-unread`;
  return row.session.agent;
}

/**
 * The session's contextValue, matched by the `when` clauses in package.json:
 * `session:<local|remote>:<agent>:<hidden|visible>:<unread|read>:<running|idle>`.
 * Any status other than "running" counts as idle.
 */
export function sessionContextValue(row: SessionRow): string {
  const s = row.session;
  return [
    "session",
    row.machineId === "local" ? "local" : "remote",
    s.agent,
    row.hidden ? "hidden" : "visible",
    row.unread ? "unread" : "read",
    s.status === "running" ? "running" : "idle",
  ].join(":");
}

function sortRows(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const ar = a.session.status === "running" ? 0 : 1;
    const br = b.session.status === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.session.updatedAt - a.session.updatedAt;
  });
}

function isWorkspace(cwd: string, folders: string[]): boolean {
  return folders.some((f) => cwd === f || cwd.startsWith(f + "/"));
}

function newestUpdatedAt(sessions: SessionNode[]): number {
  return sessions.reduce((m, n) => Math.max(m, n.row.session.updatedAt), 0);
}

export function buildTree(
  machines: MachineInput[],
  rowsByMachine: Map<string, SessionRow[]>,
  filter: TreeFilter,
  opts: BuildOptions,
): MachineNode[] {
  const result: MachineNode[] = [];
  const ordered = [...machines].sort((a, b) => Number(b.isLocal) - Number(a.isLocal));
  for (const machine of ordered) {
    if (!machine.isLocal && !filter.showRemote) continue;
    const onlyWorkspace = filter.workspaceOnly && machine.isLocal && opts.workspaceFolders.length > 0;
    const rows = (rowsByMachine.get(machine.id) ?? []).filter(
      (r) =>
        (filter.showHidden || !r.hidden) &&
        (!filter.agents || filter.agents.has(r.session.agent)) &&
        (!onlyWorkspace || isWorkspace(r.session.cwd, opts.workspaceFolders)),
    );
    const byCwd = new Map<string, SessionRow[]>();
    for (const r of rows) {
      const list = byCwd.get(r.session.cwd) ?? [];
      list.push(r);
      byCwd.set(r.session.cwd, list);
    }
    const projects: ProjectNode[] = [...byCwd.entries()].map(([cwd, list]) => ({
      kind: "project",
      machineId: machine.id,
      cwd,
      label: shortenCwd(cwd, machine.isLocal ? opts.home : machine.home ?? ""),
      sessions: sortRows(list).map((row) => ({ kind: "session", machineId: machine.id, row })),
    }));
    projects.sort((a, b) => {
      const aw = machine.isLocal && isWorkspace(a.cwd, opts.workspaceFolders) ? 0 : 1;
      const bw = machine.isLocal && isWorkspace(b.cwd, opts.workspaceFolders) ? 0 : 1;
      if (aw !== bw) return aw - bw;
      const al = newestUpdatedAt(a.sessions);
      const bl = newestUpdatedAt(b.sessions);
      return bl - al;
    });
    result.push({ kind: "machine", machine, projects });
  }
  return result;
}
