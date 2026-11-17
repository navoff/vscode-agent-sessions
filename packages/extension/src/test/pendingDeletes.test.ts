import { test } from "node:test";
import assert from "node:assert/strict";
import { duePendingDeletes, PENDING_DELETES_MAX_AGE_MS } from "../state/pendingDeletes.js";
import { windowLabel } from "../state/windowRegistry.js";

test("sessions recorded before a reload are due right after it", () => {
  assert.deepEqual(duePendingDeletes({ ids: ["a", "b"], at: 1000 }, 1000 + 5_000), ["a", "b"]);
});

test("a record left by a reload that did not happen, or a broken one, is ignored", () => {
  assert.deepEqual(duePendingDeletes({ ids: ["a"], at: 1000 }, 1000 + PENDING_DELETES_MAX_AGE_MS + 1), []);
  assert.deepEqual(duePendingDeletes({ ids: ["a"], at: 5000 }, 1000), []);
  assert.deepEqual(duePendingDeletes(undefined, 1000), []);
  assert.deepEqual(duePendingDeletes({ ids: "a", at: 1000 }, 1000), []);
  assert.deepEqual(duePendingDeletes({ ids: ["a", 3], at: 1000 }, 1000), ["a"]);
});

test("a window is named by its workspace file, or else by its first folder", () => {
  assert.equal(windowLabel({ pid: 1, workspaceFile: "/w/vscode_ai.code-workspace", folders: ["/w/a"], updatedAt: 1 }), "vscode_ai");
  assert.equal(windowLabel({ pid: 1, folders: ["/home/u/nota", "/x"], updatedAt: 1 }), "nota");
});
