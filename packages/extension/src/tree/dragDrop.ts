import type { SessionNode, TreeNode } from "./treeModel.js";

export type DropPlan =
  | { ok: true; machineId: string; cwd: string; sessions: SessionNode[] }
  /** Nothing to move; `reason` is worth showing, a drop without one is ignored silently. */
  | { ok: false; reason?: string };

/**
 * What dropping the dragged nodes on `target` moves: the dragged sessions
 * go to the folder of the target, a folder or a session in it. Sessions
 * already in that folder stay; one session that cannot be moved refuses
 * the whole drop.
 */
export function planDrop(dragged: readonly TreeNode[], target: TreeNode | undefined): DropPlan {
  if (!target || target.kind === "machine") return { ok: false };
  const cwd = target.kind === "project" ? target.cwd : target.row.session.cwd;
  if (!cwd) return { ok: false, reason: "These sessions have no folder to move a session to." };
  const sessions = dragged.filter((n): n is SessionNode => n.kind === "session" && !(n.machineId === target.machineId && n.row.session.cwd === cwd));
  if (sessions.length === 0) return { ok: false };
  if (sessions.some((n) => n.machineId !== target.machineId)) return { ok: false, reason: "A session can be moved only to a folder of its own machine." };
  if (sessions.some((n) => n.row.session.agent !== "claude")) return { ok: false, reason: "Only Claude Code sessions can be moved to another folder." };
  const live = sessions.find((n) => n.row.session.live);
  if (live) return { ok: false, reason: `"${live.row.session.title}" is open in Claude Code; close it there first.` };
  return { ok: true, machineId: target.machineId, cwd, sessions };
}
