import type { AgentKind, SessionInfo } from "@agent-sessions/core";
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
  /** Hidden as a whole; see SessionMarks.isProjectHidden. */
  hidden: boolean;
  /** Any shown session is unread. */
  unread: boolean;
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
  /** Local folder shown even with no sessions to show: where the workspace file lives, or the single open folder. */
  currentProject?: string;
  isProjectHidden?: (machineId: string, cwd: string) => boolean;
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

export interface SessionTooltip {
  title: string;
  /** Absent when the session has none or it repeats the title. */
  firstPrompt?: string;
  updated: string;
}

export function sessionTooltip(session: SessionInfo, now: number, formatTime: (ts: number) => string = (ts) => new Date(ts).toLocaleString()): SessionTooltip {
  const out: SessionTooltip = { title: session.title, updated: `${formatTime(session.updatedAt)} (${relativeTime(session.updatedAt, now)})` };
  // The field arrives from the daemon unchecked.
  const prompt: unknown = session.firstPrompt;
  if (typeof prompt === "string" && prompt && prompt !== session.title) out.firstPrompt = prompt;
  return out;
}

export function sessionIconName(row: SessionRow): string {
  const mark = row.hidden ? "-hidden" : row.unread ? "-unread" : "";
  return `${row.session.agent}${mark}${row.pinned ? "-pinned" : ""}`;
}

/**
 * The session's contextValue, matched by the `when` clauses in package.json:
 * `session:<local|remote>:<agent>:<hidden|visible>:<unread|read>:<pinned|unpinned>:<running|idle>`.
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
    row.pinned ? "pinned" : "unpinned",
    s.status === "running" ? "running" : "idle",
  ].join(":");
}

/**
 * The folder's contextValue, matched by the `when` clauses in package.json:
 * `project:<hidden|visible>:<unread|read>`.
 */
export function projectContextValue(node: ProjectNode): string {
  return ["project", node.hidden ? "hidden" : "visible", node.unread ? "unread" : "read"].join(":");
}

// Pinned first, then by creation time, newest first: a session keeps its
// place in the folder whatever its activity.
function sortRows(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.session.createdAt - a.session.createdAt;
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
    const current = machine.isLocal ? opts.currentProject : undefined;
    if (current !== undefined && !byCwd.has(current)) byCwd.set(current, []);
    const projects: ProjectNode[] = [];
    for (const [cwd, list] of byCwd) {
      const hidden = opts.isProjectHidden?.(machine.id, cwd) ?? false;
      if (hidden && !filter.showHidden && cwd !== current) continue;
      projects.push({
        kind: "project",
        machineId: machine.id,
        cwd,
        label: shortenCwd(cwd, machine.isLocal ? opts.home : machine.home ?? ""),
        hidden,
        unread: list.some((r) => r.unread),
        sessions: sortRows(list).map((row) => ({ kind: "session", machineId: machine.id, row })),
      });
    }
    projects.sort((a, b) => {
      if (a.cwd === current || b.cwd === current) return a.cwd === current ? -1 : 1;
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
