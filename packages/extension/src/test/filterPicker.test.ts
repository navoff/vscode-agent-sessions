import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilterPicks, buildFilterItems } from "../tree/filterPicker.js";

test("buildFilterItems has three sections and five items", () => {
  const items = buildFilterItems({ agents: ["codex"], workspaceOnly: true, showRemote: false }, true);
  assert.deepEqual(items.filter((i) => i.kind === "separator").map((i) => i.label), ["Agents", "Projects", "Remote machines"]);
  const picked = Object.fromEntries(items.flatMap((i) => (i.kind === "item" ? [[i.id, i.picked]] : [])));
  assert.deepEqual(picked, {
    "agent:claude": false,
    "agent:codex": true,
    "agent:opencode": false,
    workspaceOnly: true,
    showRemote: false,
  });
  assert.equal(items.length, 8);
});

test("buildFilterItems picks all agents when agents is undefined and marks missing workspace", () => {
  const items = buildFilterItems({ agents: undefined, workspaceOnly: false, showRemote: true }, false);
  const agents = items.filter((i) => i.kind === "item" && i.id.startsWith("agent:"));
  assert.ok(agents.every((i) => i.kind === "item" && i.picked));
  const ws = items.find((i) => i.kind === "item" && i.id === "workspaceOnly");
  assert.ok(ws && ws.kind === "item");
  assert.equal(ws.label, "Only the workspace open in this window");
  assert.equal(ws.description, "(no folder open)");
  const withFolder = buildFilterItems({ agents: undefined, workspaceOnly: false, showRemote: true }, true).find((i) => i.kind === "item" && i.id === "workspaceOnly");
  assert.equal(withFolder && withFolder.kind === "item" ? withFolder.description : "x", undefined);
});

test("applyFilterPicks maps picks to a filter state", () => {
  assert.deepEqual(applyFilterPicks(["agent:claude", "agent:codex", "agent:opencode", "showRemote"]), { agents: undefined, workspaceOnly: false, showRemote: true });
  assert.deepEqual(applyFilterPicks(["agent:codex", "workspaceOnly"]), { agents: ["codex"], workspaceOnly: true, showRemote: false });
  assert.deepEqual(applyFilterPicks([]), { agents: undefined, workspaceOnly: false, showRemote: false });
});
