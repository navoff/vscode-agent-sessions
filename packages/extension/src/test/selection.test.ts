import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "@agent-sessions/core";
import type { MachineNode, ProjectNode, SessionNode } from "../tree/treeModel.js";
import { selectionTargets } from "../tree/selection.js";

const s = (id: string): SessionInfo => ({ agent: "claude", id, title: id, cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle" });
const node = (id: string, machineId = "local"): SessionNode => ({ kind: "session", machineId, row: { machineId, session: s(id), hidden: false, unread: false } });
const project: ProjectNode = { kind: "project", machineId: "local", cwd: "/w", label: "~/w", hidden: false, unread: false, sessions: [] };
const machine: MachineNode = { kind: "machine", machine: { id: "local", name: "This machine", isLocal: true, state: "connected" }, projects: [] };

test("uses the selection when it contains the clicked node", () => {
  const a = node("a");
  const b = node("b");
  assert.deepEqual(selectionTargets(a, [b, a, project, machine]).map((n) => n.row.session.id), ["b", "a"]);
});

test("falls back to the clicked node when the selection does not contain it", () => {
  const a = node("a");
  const b = node("b");
  assert.deepEqual(selectionTargets(a, [b]).map((n) => n.row.session.id), ["a"]);
  assert.deepEqual(selectionTargets(a, undefined).map((n) => n.row.session.id), ["a"]);
});

test("uses the whole selection when no node is passed (keybinding)", () => {
  const a = node("a");
  const b = node("b");
  assert.deepEqual(selectionTargets(undefined, [a, project, b]).map((n) => n.row.session.id), ["a", "b"]);
  assert.deepEqual(selectionTargets(undefined, undefined), []);
});

test("ignores non-session clicks and duplicates", () => {
  assert.deepEqual(selectionTargets(project, [project]), []);
  assert.deepEqual(selectionTargets(undefined, []), []);
  const a = node("a");
  const a2 = node("a");
  assert.equal(selectionTargets(a, [a, a2]).length, 1);
  const remote = node("a", "hz");
  assert.equal(selectionTargets(a, [a, remote]).length, 2);
});
