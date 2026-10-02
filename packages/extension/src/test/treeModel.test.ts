import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SessionInfo } from "@agent-sessions/core";
import { buildTree, projectContextValue, relativeTime, sessionContextValue, sessionDescription, sessionIconName, shortenCwd, type MachineInput } from "../tree/treeModel.js";
import type { SessionRow } from "../state/sessionStore.js";

const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ agent: "claude", id, title: id, cwd: "/home/u/work/a", createdAt: 1, updatedAt: 1000, status: "idle", ...over });
const row = (machineId: string, session: SessionInfo, over: Partial<SessionRow> = {}): SessionRow => ({ machineId, session, hidden: false, unread: false, pinned: false, ...over });
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

test("sessionDescription and icon reflect status, unread, hidden and pinned", () => {
  const now = 1000 + 60_000 * 7;
  assert.equal(sessionDescription(row("local", s("a", { status: "running" })), now), "● running");
  assert.equal(sessionDescription(row("local", s("a"), { unread: true }), now), "7 min ago");
  assert.equal(sessionDescription(row("local", s("a"), { hidden: true }), now), "hidden · 7 min ago");
  assert.equal(sessionIconName(row("local", s("a", { status: "running" }))), "claude");
  assert.equal(sessionIconName(row("local", s("a"), { unread: true })), "claude-unread");
  assert.equal(sessionIconName(row("local", s("a", { agent: "codex" }), { hidden: true })), "codex-hidden");
  assert.equal(sessionIconName(row("local", s("a"))), "claude");
  assert.equal(sessionIconName(row("local", s("a"), { pinned: true })), "claude-pinned");
  assert.equal(sessionIconName(row("local", s("a"), { unread: true, pinned: true })), "claude-unread-pinned");
  assert.equal(sessionIconName(row("local", s("a", { agent: "codex" }), { hidden: true, pinned: true })), "codex-hidden-pinned");
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
  const tree = buildTree([local, remote, remoteNoHome], rows, { agents: undefined, showRemote: true, workspaceOnly: false, showHidden: false }, opts);
  assert.deepEqual(tree.map((m) => m.machine.id), ["local", "hz", "hz2"]);
  const projects = tree[0].projects;
  assert.deepEqual(projects.map((p) => p.label), ["~/work/b", "~/work/a"]);
  assert.deepEqual(projects[1].sessions.map((n) => n.row.session.id), ["run", "new", "old"]);
  assert.equal(tree[1].projects[0].sessions.length, 1);
  assert.equal(tree[1].projects[0].label, "~/x");
  assert.equal(tree[2].projects[0].label, "/srv/app");

  const noRemote = buildTree([local, remote], rows, { agents: undefined, showRemote: false, workspaceOnly: false, showHidden: false }, opts);
  assert.deepEqual(noRemote.map((m) => m.machine.id), ["local"]);

  const codexOnly = buildTree([local, remote], rows, { agents: new Set(["codex"]), showRemote: true, workspaceOnly: false, showHidden: false }, opts);
  assert.equal(codexOnly[0].projects.length, 1);
  assert.equal(codexOnly[0].projects[0].sessions[0].row.session.id, "cx");

  const withHidden = buildTree([local], rows, { agents: undefined, showRemote: true, workspaceOnly: false, showHidden: true }, opts);
  assert.ok(withHidden[0].projects[1].sessions.some((n) => n.row.session.id === "hid"));
});

test("machine without sessions still appears with no projects", () => {
  const tree = buildTree([remote], new Map(), { agents: undefined, showRemote: true, workspaceOnly: false, showHidden: false }, opts);
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
  const tree = buildTree([local], rows, { agents: undefined, showRemote: true, workspaceOnly: false, showHidden: false }, noWorkspace);
  const projects = tree[0].projects;
  assert.deepEqual(projects.map((p) => p.label), ["/p1", "/p2"]);
  assert.deepEqual(projects[0].sessions.map((n) => n.row.session.id), ["p1run", "p1new"]);
});

test("pinned sessions come first in their folder, each group keeps the usual order", () => {
  const rows = new Map<string, SessionRow[]>([
    ["local", [
      row("local", s("run", { status: "running", updatedAt: 5 })),
      row("local", s("new", { updatedAt: 500 })),
      row("local", s("pinOld", { updatedAt: 10 }), { pinned: true }),
      row("local", s("pinRun", { status: "running", updatedAt: 1 }), { pinned: true }),
      row("local", s("pinNew", { updatedAt: 400 }), { pinned: true }),
      row("local", s("other", { cwd: "/home/u/work/c", updatedAt: 900 })),
      row("local", s("otherPin", { cwd: "/home/u/work/d", updatedAt: 1 }), { pinned: true }),
    ]],
  ]);
  const tree = buildTree([local], rows, { agents: undefined, showRemote: true, workspaceOnly: false, showHidden: false }, { home: "/home/u", workspaceFolders: [] });
  const a = tree[0].projects.find((p) => p.cwd === "/home/u/work/a")!;
  assert.deepEqual(a.sessions.map((n) => n.row.session.id), ["pinRun", "pinNew", "pinOld", "run", "new"]);
  // A pin does not move its folder.
  assert.deepEqual(tree[0].projects.map((p) => p.label), ["~/work/c", "~/work/a", "~/work/d"]);
});

test("sessionContextValue names place, agent, marks and status", () => {
  assert.equal(sessionContextValue(row("local", s("a"))), "session:local:claude:visible:read:unpinned:idle");
  assert.equal(sessionContextValue(row("hz", s("a", { agent: "codex", status: "running" }), { hidden: true, unread: true, pinned: true })), "session:remote:codex:hidden:unread:pinned:running");
  assert.equal(sessionContextValue(row("local", s("a", { status: "unknown" }))), "session:local:claude:visible:read:unpinned:idle");
});

interface MenuItem { command: string; when?: string; group?: string }
// package.json sits next to out/, two levels above this compiled test.
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  contributes: { commands: Array<{ command: string; enablement?: string }>; menus: { "view/item/context": MenuItem[]; "view/title": MenuItem[]; commandPalette: MenuItem[] } };
};

test("header toggles with two icons use complementary when clauses", () => {
  const pairs: Array<[string, string, string]> = [
    ["agentSessions.filterAgents", "agentSessions.filterSessionsActive", "agentSessions.filterActive"],
    ["agentSessions.toggleHidden", "agentSessions.toggleHiddenActive", "agentSessions.showHidden"],
  ];
  const title = new Map(manifest.contributes.menus["view/title"].map((i) => [i.command, i.when ?? ""]));
  const palette = new Map(manifest.contributes.menus.commandPalette.map((i) => [i.command, i.when ?? ""]));
  for (const [off, on, key] of pairs) {
    assert.equal(title.get(off), `view == agentSessions.view && !${key}`);
    assert.equal(title.get(on), `view == agentSessions.view && ${key}`);
    assert.equal(palette.get(on), "false");
  }
});
/** Evaluates the `viewItem =~ /re/` or `!(viewItem =~ /re/)` part of a when clause; other terms are taken as true. */
function matchesViewItem(clause: string | undefined, contextValue: string): boolean {
  const m = clause?.match(/(!\()?viewItem =~ \/(.+?)\/(?:\)|\s|$)/);
  if (!m) return true;
  return new RegExp(m[2]).test(contextValue) !== Boolean(m[1]);
}
/** Context menu commands of a session, or with `inline` the buttons in its row. */
function sessionMenu(contextValue: string, inline = false): string[] {
  const enablement = new Map(manifest.contributes.commands.map((c) => [c.command, c.enablement]));
  return manifest.contributes.menus["view/item/context"]
    .filter((i) => (i.group?.startsWith("inline") ?? false) === inline)
    .filter((i) => matchesViewItem(i.when, contextValue) && matchesViewItem(enablement.get(i.command), contextValue))
    .map((i) => i.command.replace("agentSessions.", ""));
}

test("session menu entries in package.json follow the contextValue", () => {
  const cv = (machineId: string, over: Partial<SessionInfo>, marks: Partial<SessionRow> = {}) => sessionContextValue(row(machineId, s("a", over), marks));
  assert.deepEqual(sessionMenu(cv("local", {})), ["openSession", "resumeInTerminal", "markUnread", "hideSession", "pinSession", "copySessionId", "deleteSession"]);
  assert.deepEqual(sessionMenu(cv("local", {}, { unread: true, hidden: true, pinned: true })), ["openSession", "resumeInTerminal", "markRead", "unhideSession", "unpinSession", "copySessionId", "deleteSession"]);
  assert.deepEqual(sessionMenu(cv("local", { status: "running" })), ["openSession", "resumeInTerminal", "markUnread", "hideSession", "pinSession", "copySessionId"]);
  assert.deepEqual(sessionMenu(cv("hz", { agent: "codex" })), ["markUnread", "hideSession", "pinSession", "copySessionId", "deleteSession"]);
  assert.deepEqual(sessionMenu(cv("local", { agent: "opencode" })), ["openSession", "markUnread", "hideSession", "pinSession", "copySessionId", "deleteSession"]);
});

test("a session row has one inline button: pin, or unpin once pinned", () => {
  const cv = (over: Partial<SessionInfo>, marks: Partial<SessionRow> = {}) => sessionContextValue(row("local", s("a", over), marks));
  assert.deepEqual(sessionMenu(cv({}), true), ["pinSession"]);
  assert.deepEqual(sessionMenu(cv({ status: "running" }), true), ["pinSession"]);
  assert.deepEqual(sessionMenu(cv({}, { pinned: true }), true), ["unpinSession"]);
  assert.deepEqual(sessionMenu(cv({ status: "running" }, { pinned: true, hidden: true }), true), ["unpinSession"]);
  // A folder row has the New Session button instead.
  assert.deepEqual(sessionMenu("project:visible:read", true), ["newSession"]);
  assert.deepEqual(sessionMenu("project:hidden:unread", true), ["newSession"]);
  const palette = new Map(manifest.contributes.menus.commandPalette.map((i) => [i.command, i.when ?? ""]));
  assert.equal(palette.get("agentSessions.pinSession"), "false");
  assert.equal(palette.get("agentSessions.unpinSession"), "false");
});

test("workspaceOnly keeps only local rows under workspace folders and leaves remote alone", () => {
  const rows = new Map<string, SessionRow[]>([
    ["local", [
      row("local", s("in", { cwd: "/home/u/work/b" })),
      row("local", s("sub", { cwd: "/home/u/work/b/sub" })),
      row("local", s("sibling", { cwd: "/home/u/work/bb" })),
      row("local", s("out", { cwd: "/home/u/work/a" })),
    ]],
    ["hz", [row("hz", s("r1", { cwd: "/home/navoff/x" }))]],
  ]);
  const filter = { agents: undefined, showRemote: true, workspaceOnly: true, showHidden: false };
  const tree = buildTree([local, remote], rows, filter, opts);
  const ids = tree[0].projects.flatMap((p) => p.sessions.map((n) => n.row.session.id)).sort();
  assert.deepEqual(ids, ["in", "sub"]);
  assert.equal(tree[1].projects[0].sessions.length, 1);
});

test("workspaceOnly has no effect without workspace folders", () => {
  const rows = new Map<string, SessionRow[]>([
    ["local", [row("local", s("a", { cwd: "/p1" })), row("local", s("b", { cwd: "/p2" }))]],
  ]);
  const tree = buildTree([local], rows, { agents: undefined, showRemote: true, workspaceOnly: true, showHidden: false }, { home: "/home/u", workspaceFolders: [] });
  assert.equal(tree[0].projects.length, 2);
});

test("a hidden folder is dropped whole unless showHidden, and its sessions keep their own marks", () => {
  const rows = new Map<string, SessionRow[]>([
    ["local", [
      row("local", s("a", { cwd: "/home/u/work/a" }), { hidden: true }),
      row("local", s("b", { cwd: "/home/u/work/a" }), { unread: true }),
      row("local", s("c", { cwd: "/home/u/work/c" })),
    ]],
  ]);
  const isProjectHidden = (machineId: string, cwd: string) => machineId === "local" && cwd === "/home/u/work/a";
  const filter = { agents: undefined, showRemote: true, workspaceOnly: false, showHidden: false };
  const tree = buildTree([local], rows, filter, { ...opts, isProjectHidden });
  assert.deepEqual(tree[0].projects.map((p) => p.label), ["~/work/c"]);
  assert.equal(projectContextValue(tree[0].projects[0]), "project:visible:read");

  const shown = buildTree([local], rows, { ...filter, showHidden: true }, { ...opts, isProjectHidden });
  const a = shown[0].projects.find((p) => p.cwd === "/home/u/work/a")!;
  assert.equal(a.hidden, true);
  assert.equal(a.unread, true);
  assert.equal(projectContextValue(a), "project:hidden:unread");
  assert.deepEqual(a.sessions.map((n) => [n.row.session.id, n.row.hidden]), [["a", true], ["b", false]]);

  // Without the callback nothing is hidden.
  assert.equal(buildTree([local], rows, filter, opts)[0].projects.length, 2);
});
