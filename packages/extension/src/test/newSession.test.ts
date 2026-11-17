import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { openSession, startNewSession } from "../commands.js";

interface WindowStub { pid: number; workspaceFile?: string; folders: string[]; updatedAt: number }
const deps = (bound: Record<string, string> = {}, windows: WindowStub[] = [], pending: string[] = []) =>
  ({
    store: { markRead() {} },
    refresh() {},
    codexTabs: { tabOf: (id: string) => bound[id] },
    pendingOpen: async (_machineId: string, session: { id: string }) => { pending.push(session.id); },
    windowFor: async (cwd: string) => windows.find((w) => w.folders[0] === cwd),
    log: { appendLine() {} },
  }) as unknown as Parameters<typeof openSession>[0];
const codexSession = (id: string, cwd = "/tmp") => ({ agent: "codex" as const, id, title: "Example", cwd, createdAt: 1, updatedAt: 2, status: "idle" as const });
// Real folders: a session's folder is looked up on disk before a hand-over.
const sessionFolder = mkdtempSync(join(tmpdir(), "agent-sessions-codex-"));
const otherFolder = mkdtempSync(join(tmpdir(), "agent-sessions-other-"));

// Exercise the command handler with only the VS Code boundary replaced.
const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL("../commands.js", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  write: false,
}).outputFiles[0].text;
const require = createRequire(import.meta.url);

class TabInputCustom {
  constructor(readonly uri: { scheme: string; path: string; toString(): string }, readonly viewType: string) {}
}
const codexTab = (path: string, query = "") => ({
  input: new TabInputCustom({ scheme: "openai-codex", path, toString: () => `openai-codex://route${path}${query}` }, "chatgpt.conversationEditor"),
  group: { viewColumn: 2 },
});

function commands(target: "panel" | "sidebar", failure?: Error, version = "26.51007.21434", choice?: string, tabs: unknown[] = [], folders: string[] = []) {
  const calls: { id: string; args: unknown[] }[] = [];
  const warnings: { message: string; actions: string[] }[] = [];
  const links: string[] = [];
  const vscode = {
    extensions: { getExtension: () => ({ packageJSON: { version } }) },
    TabInputCustom,
    window: {
      tabGroups: { all: [{ tabs }] },
      showWarningMessage: async (message: string, ...actions: string[]) => {
        warnings.push({ message, actions });
        return choice;
      },
    },
    env: { openExternal: async (uri: URL) => { links.push(String(uri)); return true; } },
    workspace: {
      getConfiguration: () => ({ get: () => target }),
      workspaceFolders: folders.map((f) => ({ uri: { fsPath: f, scheme: "file", toString: () => `file://${f}` } })),
    },
    Uri: {
      parse: (uri: string) => new URL(uri),
      file: (path: string) => ({ fsPath: path, with: (c: { scheme: string; authority: string }) => new URL(`${c.scheme}://${c.authority}${path}`) }),
    },
    commands: { executeCommand: async (id: string, ...args: unknown[]) => {
      calls.push({ id, args });
      if (failure && id === "vscode.openWith") throw failure;
    } },
  };
  const module = { exports: {} as { startNewSession: typeof startNewSession; openSession: typeof openSession } };
  runInNewContext(bundle, { module, exports: module.exports, require: (id: string) => id === "vscode" ? vscode : require(id) });
  return { start: module.exports.startNewSession, open: module.exports.openSession, calls, warnings, links };
}

test("each new Codex panel opens a distinct resource instead of reusing an existing chat", async () => {
  const { start, calls } = commands("panel");
  await start("codex");
  await start("codex");
  assert.deepEqual(calls.map((c) => c.id), ["vscode.openWith", "vscode.openWith"]);
  const uris = calls.map((c) => new URL(String(c.args[0])));
  for (const uri of uris) {
    assert.equal(uri.protocol, "openai-codex:");
    assert.equal(uri.host, "route");
    assert.equal(uri.pathname, "/extension/panel/new");
    assert.ok(uri.searchParams.get("nonce"));
  }
  assert.notEqual(uris[0].href, uris[1].href);
  for (const { args } of calls) {
    assert.equal(args[1], "chatgpt.conversationEditor");
    assert.equal((args[2] as { preview: boolean }).preview, false);
    assert.equal((args[2] as { preserveFocus: boolean }).preserveFocus, false);
  }
});

test("starting a Codex session in the sidebar keeps the sidebar commands", async () => {
  const { start, calls } = commands("sidebar");
  await start("codex");
  assert.deepEqual(calls.map((c) => c.id), ["chatgpt.openSidebar", "chatgpt.newChat"]);
});

test("starting a Codex panel waits for opening and propagates its failure", async () => {
  const failure = new Error("cannot open editor");
  const { start } = commands("panel", failure);
  await assert.rejects(start("codex"), (error) => error === failure);
});

test("known affected Codex versions warn once without blocking new sessions and open the issue on request", async () => {
  for (const version of ["26.1021.22027", "26.51021.22027"]) {
    const { start, calls, warnings, links } = commands("panel", undefined, version, "View Issue");
    await start("codex");
    await start("codex");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes(version));
    assert.deepEqual(warnings[0].actions, ["View Issue"]);
    assert.deepEqual(links, ["https://github.com/openai/codex/issues/59921"]);
    assert.deepEqual(calls.map((c) => c.id), ["vscode.openWith", "vscode.openWith"]);
  }
});

test("dismissing the Codex warning keeps opening the sidebar without opening a browser", async () => {
  const { start, calls, warnings, links } = commands("sidebar", undefined, "26.1021.22027");
  await start("codex");
  assert.equal(warnings.length, 1);
  assert.deepEqual(links, []);
  assert.deepEqual(calls.map((c) => c.id), ["chatgpt.openSidebar", "chatgpt.newChat"]);
});

test("unlisted Codex versions and Claude do not get the Codex compatibility warning", async () => {
  for (const version of ["26.51007.21434", "26.1021.22028", "27.1.1", ""]) {
    const { start, warnings } = commands("panel", undefined, version);
    await start("codex");
    assert.deepEqual(warnings, []);
  }
  const { start, warnings } = commands("panel", undefined, "26.1021.22027");
  await start("claude");
  assert.deepEqual(warnings, []);
});

test("resuming a Codex session shows the same warning as creating a new one", async () => {
  const { open, start, warnings } = commands("sidebar", undefined, "26.1021.22027");
  const session = {
    agent: "codex" as const, id: "1535df9f-12b4-4971-8a25-36336a643122",
    title: "Example", cwd: "/tmp", createdAt: 1, updatedAt: 2, status: "idle" as const,
  };
  await open(deps(), "local", session);
  assert.equal(warnings.length, 1);
  await start("codex");
  assert.equal(warnings.length, 1);
});

test("opening a Codex session brings forward the new-chat tab it was started in", async () => {
  const id = "1535df9f-12b4-4971-8a25-36336a643122";
  const newChat = codexTab("/extension/panel/new", "?nonce=a");
  const { open, calls } = commands("panel", undefined, undefined, undefined, [codexTab("/extension/panel/new", "?nonce=b"), newChat]);
  await open(deps({ [id]: "openai-codex://route/extension/panel/new?nonce=a" }), "local", codexSession(id));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "vscode.openWith");
  assert.equal(calls[0].args[0], newChat.input.uri);
  assert.equal((calls[0].args[2] as { viewColumn: number }).viewColumn, 2);
});

test("opening a Codex session without a tab of its own opens its thread, not a new-chat tab", async () => {
  const id = "1535df9f-12b4-4971-8a25-36336a643122";
  const { open, calls } = commands("panel", undefined, undefined, undefined, [codexTab("/extension/panel/new", "?nonce=a")]);
  await open(deps(), "local", codexSession(id));
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].args[0]), `openai-codex://route/local/${id}`);
});

const ID = "1535df9f-12b4-4971-8a25-36336a643122";
const tray = { autoHandOver: true, raise: true };
const ids = (calls: { id: string }[]) => calls.map((c) => c.id);

test("a tray click on a Codex session of another window's folder hands it over to that window", async () => {
  const pending: string[] = [];
  const { open, calls } = commands("panel", undefined, undefined, undefined, [], [otherFolder]);
  const owner = { pid: 1, workspaceFile: "/w/owner.code-workspace", folders: [sessionFolder], updatedAt: 1 };
  await open(deps({}, [owner], pending), "local", codexSession(ID, sessionFolder), tray);
  assert.deepEqual(pending, [ID]);
  assert.deepEqual(ids(calls), ["vscode.openFolder"]);
  assert.equal((calls[0].args[0] as { fsPath: string }).fsPath, owner.workspaceFile);
});

test("a tray click on a Codex session this window shows in a tab opens it here", async () => {
  const pending: string[] = [];
  const tab = codexTab("/extension/panel/new", "?nonce=a");
  const { open, calls } = commands("panel", undefined, undefined, undefined, [tab], [otherFolder]);
  const owner = { pid: 1, folders: [sessionFolder], updatedAt: 1 };
  await open(deps({ [ID]: "openai-codex://route/extension/panel/new?nonce=a" }, [owner], pending), "local", codexSession(ID, sessionFolder), tray);
  assert.deepEqual(pending, []);
  assert.deepEqual(ids(calls), ["vscode.openFolder", "vscode.openWith"]);
  assert.equal(calls[1].args[0], tab.input.uri);
});

test("a tray click on a Codex session of this window's folder, or of a folder no window has, opens it here", async () => {
  for (const folders of [[sessionFolder], [otherFolder]]) {
    const pending: string[] = [];
    const { open, calls } = commands("panel", undefined, undefined, undefined, [], folders);
    await open(deps({}, [], pending), "local", codexSession(ID, sessionFolder), tray);
    assert.deepEqual(pending, []);
    assert.deepEqual(ids(calls), ["vscode.openFolder", "vscode.openWith"]);
    assert.equal(String(calls[1].args[0]), `openai-codex://route/local/${ID}`);
  }
});

test("opening a Codex session from the tree of this window does not hand it over", async () => {
  const pending: string[] = [];
  const { open, calls } = commands("panel", undefined, undefined, undefined, [], [otherFolder]);
  const owner = { pid: 1, folders: [sessionFolder], updatedAt: 1 };
  await open(deps({}, [owner], pending), "local", codexSession(ID, sessionFolder));
  assert.deepEqual(pending, []);
  assert.deepEqual(ids(calls), ["vscode.openWith"]);
});
