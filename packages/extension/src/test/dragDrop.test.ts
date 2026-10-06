import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "@agent-sessions/core";
import { planDrop, type DropPlan } from "../tree/dragDrop.js";
import type { MachineNode, ProjectNode, SessionNode } from "../tree/treeModel.js";

function session(machineId: string, id: string, cwd: string, over: Partial<SessionInfo> = {}): SessionNode {
  const s: SessionInfo = { agent: "claude", id, title: id, cwd, createdAt: 1, updatedAt: 1, status: "idle", ...over };
  return { kind: "session", machineId, row: { machineId, session: s, unread: false, hidden: false, pinned: false } };
}

function project(machineId: string, cwd: string, sessions: SessionNode[] = []): ProjectNode {
  return { kind: "project", machineId, cwd, label: cwd, hidden: false, unread: false, sessions };
}

const reason = (plan: DropPlan) => (plan.ok ? "" : plan.reason ?? "");
const machine: MachineNode = { kind: "machine", machine: { id: "local", name: "local", isLocal: true, state: "connected" }, projects: [] };

test("a drop on a folder, or on a session in it, moves the dragged sessions there", () => {
  const a = session("local", "a", "/x");
  const b = session("local", "b", "/y");
  assert.deepEqual(planDrop([a, b], project("local", "/z")), { ok: true, machineId: "local", cwd: "/z", sessions: [a, b] });
  assert.deepEqual(planDrop([a], session("local", "c", "/z")), { ok: true, machineId: "local", cwd: "/z", sessions: [a] });
});

test("Codex sessions move as well", () => {
  const c = session("local", "c", "/x", { agent: "codex" });
  assert.deepEqual(planDrop([c], project("local", "/z")), { ok: true, machineId: "local", cwd: "/z", sessions: [c] });
});

test("sessions already in the folder stay, and other dragged nodes are ignored", () => {
  const a = session("local", "a", "/x");
  const z = session("local", "z", "/z");
  assert.deepEqual(planDrop([a, z, project("local", "/x", [a])], project("local", "/z")), { ok: true, machineId: "local", cwd: "/z", sessions: [a] });
  assert.deepEqual(planDrop([z], project("local", "/z")), { ok: false });
  assert.deepEqual(planDrop([project("local", "/x", [a])], project("local", "/z")), { ok: false });
});

test("a drop outside a folder is ignored", () => {
  const a = session("local", "a", "/x");
  assert.deepEqual(planDrop([a], undefined), { ok: false });
  assert.deepEqual(planDrop([a], machine), { ok: false });
  assert.match(reason(planDrop([a], project("local", ""))), /no folder/);
});

test("one session that cannot be moved refuses the whole drop", () => {
  const a = session("local", "a", "/x");
  const target = project("local", "/z");
  assert.match(reason(planDrop([a, session("hz", "r", "/x")], target)), /its own machine/);
  assert.match(reason(planDrop([a, session("local", "o", "/x", { agent: "opencode" })], target)), /Only Claude Code and Codex sessions/);
  assert.match(reason(planDrop([a, session("local", "c", "/x", { agent: "codex", title: "Busy", status: "running" })], target)), /"Busy" is running/);
  assert.match(reason(planDrop([a, session("local", "l", "/x", { title: "Live", live: { pid: 7, statusUpdatedAt: 1 } })], target)), /"Live" is open in Claude Code/);
  // The same folder path on another machine is another folder.
  assert.match(reason(planDrop([session("hz", "r", "/z")], target)), /its own machine/);
});
