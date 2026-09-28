import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "@agent-sessions/core";
import { buildTree, relativeTime, sessionDescription, sessionIconName, shortenCwd, type MachineInput } from "../tree/treeModel.js";
import type { SessionRow } from "../state/sessionStore.js";

const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ agent: "claude", id, title: id, cwd: "/home/u/work/a", createdAt: 1, updatedAt: 1000, status: "idle", ...over });
const row = (machineId: string, session: SessionInfo, over: Partial<SessionRow> = {}): SessionRow => ({ machineId, session, hidden: false, unread: false, ...over });
const local: MachineInput = { id: "local", name: "This machine", isLocal: true, state: "connected" };
const remote: MachineInput = { id: "hz", name: "hetzner", isLocal: false, state: "error", error: "ssh failed", home: "/home/navoff" };
const remoteNoHome: MachineInput = { id: "hz2", name: "hetzner2", isLocal: false, state: "error", error: "ssh failed" };
const opts = { home: "/home/u", workspaceFolders: ["/home/u/work/b"] };

test("shortenCwd replaces home with ~", () => {
  assert.equal(shortenCwd("/home/u/work/a", "/home/u"), "~/work/a");
  assert.equal(shortenCwd("/opt/x", "/home/u"), "/opt/x");
  assert.equal(shortenCwd("", "/home/u"), "(no folder)");
  assert.equal(shortenCwd("/home/u", "/home/u"), "~");
  assert.equal(shortenCwd("/opt/x", ""), "/opt/x");
});

test("relativeTime formats coarse buckets", () => {
  const now = 10_000_000;
  assert.equal(relativeTime(now - 30_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 min ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 d ago");
});

test("sessionDescription and icon reflect status, unread and hidden", () => {
  const now = 1000 + 60_000 * 7;
  assert.equal(sessionDescription(row("local", s("a", { status: "running" })), now), "running");
  assert.equal(sessionDescription(row("local", s("a"), { unread: true }), now), "● 7 min ago");
  assert.equal(sessionDescription(row("local", s("a"), { hidden: true }), now), "hidden · 7 min ago");
  assert.equal(sessionIconName(row("local", s("a", { status: "running" }))), "claude-running");
  assert.equal(sessionIconName(row("local", s("a", { agent: "codex" }), { hidden: true })), "codex-hidden");
  assert.equal(sessionIconName(row("local", s("a"))), "claude");
});

test("buildTree groups by machine and project, sorts and filters", () => {
  const rows = new Map<string, SessionRow[]>([
    ["local", [
      row("local", s("old", { updatedAt: 10 })),
      row("local", s("run", { status: "running", updatedAt: 5 })),
      row("local", s("new", { updatedAt: 500 })),
      row("local", s("cx", { agent: "codex", cwd: "/home/u/work/b", updatedAt: 50 })),
      row("local", s("hid", { updatedAt: 999 }), { hidden: true }),
    ]],
    ["hz", [row("hz", s("r1", { cwd: "/home/navoff/x" }))]],
    ["hz2", [row("hz2", s("r2", { cwd: "/srv/app" }))]],
  ]);
  const tree = buildTree([local, remote, remoteNoHome], rows, { agents: undefined, showRemote: true, showHidden: false }, opts);
  assert.deepEqual(tree.map((m) => m.machine.id), ["local", "hz", "hz2"]);
  const projects = tree[0].projects;
  assert.deepEqual(projects.map((p) => p.label), ["~/work/b", "~/work/a"]);
  assert.deepEqual(projects[1].sessions.map((n) => n.row.session.id), ["run", "new", "old"]);
  assert.equal(tree[1].projects[0].sessions.length, 1);
  assert.equal(tree[1].projects[0].label, "~/x");
  assert.equal(tree[2].projects[0].label, "/srv/app");

  const noRemote = buildTree([local, remote], rows, { agents: undefined, showRemote: false, showHidden: false }, opts);
  assert.deepEqual(noRemote.map((m) => m.machine.id), ["local"]);

  const codexOnly = buildTree([local, remote], rows, { agents: new Set(["codex"]), showRemote: true, showHidden: false }, opts);
  assert.equal(codexOnly[0].projects.length, 1);
  assert.equal(codexOnly[0].projects[0].sessions[0].row.session.id, "cx");

  const withHidden = buildTree([local], rows, { agents: undefined, showRemote: true, showHidden: true }, opts);
  assert.ok(withHidden[0].projects[1].sessions.some((n) => n.row.session.id === "hid"));
});

test("machine without sessions still appears with no projects", () => {
  const tree = buildTree([remote], new Map(), { agents: undefined, showRemote: true, showHidden: false }, opts);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].projects, []);
});

test("projects without workspace match are ordered by their newest session", () => {
  const rows = new Map<string, SessionRow[]>([
    ["local", [
      row("local", s("p1run", { cwd: "/p1", status: "running", updatedAt: 1 })),
      row("local", s("p1new", { cwd: "/p1", updatedAt: 1000 })),
      row("local", s("p2", { cwd: "/p2", updatedAt: 500 })),
    ]],
  ]);
  const noWorkspace = { home: "/home/u", workspaceFolders: [] };
  const tree = buildTree([local], rows, { agents: undefined, showRemote: true, showHidden: false }, noWorkspace);
  const projects = tree[0].projects;
  assert.deepEqual(projects.map((p) => p.label), ["/p1", "/p2"]);
  assert.deepEqual(projects[0].sessions.map((n) => n.row.session.id), ["p1run", "p1new"]);
});
