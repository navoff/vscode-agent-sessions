import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import type { openSession, startNewSession } from "../commands.js";

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

function commands(target: "panel" | "sidebar", failure?: Error, version = "26.51007.21434", choice?: string) {
  const calls: { id: string; args: unknown[] }[] = [];
  const warnings: { message: string; actions: string[] }[] = [];
  const links: string[] = [];
  const vscode = {
    extensions: { getExtension: () => ({ packageJSON: { version } }) },
    TabInputCustom: class {},
    window: {
      tabGroups: { all: [] },
      showWarningMessage: async (message: string, ...actions: string[]) => {
        warnings.push({ message, actions });
        return choice;
      },
    },
    env: { openExternal: async (uri: URL) => { links.push(String(uri)); return true; } },
    workspace: { getConfiguration: () => ({ get: () => target }) },
    Uri: { parse: (uri: string) => new URL(uri) },
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
  await open({ store: { markRead() {} }, refresh() {} } as unknown as Parameters<typeof open>[0], "local", session);
  assert.equal(warnings.length, 1);
  await start("codex");
  assert.equal(warnings.length, 1);
});
