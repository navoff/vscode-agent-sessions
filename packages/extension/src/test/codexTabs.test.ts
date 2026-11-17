import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexTabTracker } from "../state/codexTabs.js";

const thread = (id: string, createdAt: number) => ({ id, createdAt });
const NEW_A = "openai-codex://route/extension/panel/new?nonce=a";
const NEW_B = "openai-codex://route/extension/panel/new?nonce=b";

test("a thread is bound to the new-chat tab that was in front when it was created", () => {
  const t = new CodexTabTracker();
  t.noteActive(1000, NEW_A);
  // The thread shows up in the store after the user moved on to another tab.
  t.noteActive(1500, undefined);
  assert.equal(t.update([thread("x", 1200)], new Set([NEW_A]), 2000), true);
  assert.equal(t.tabOf("x"), NEW_A);
  assert.equal(t.sessionOf(NEW_A), "x");
});

test("of two new-chat tabs, each gets the thread created while it was in front", () => {
  const t = new CodexTabTracker();
  t.noteActive(1000, NEW_A);
  t.noteActive(2000, NEW_B);
  t.update([thread("in-b", 2500), thread("in-a", 1500)], new Set([NEW_A, NEW_B]), 3000);
  assert.equal(t.tabOf("in-a"), NEW_A);
  assert.equal(t.tabOf("in-b"), NEW_B);
});

test("threads created while no new-chat tab was in front, or before tracking began, stay unbound", () => {
  const t = new CodexTabTracker();
  t.noteActive(1000, undefined);
  t.noteActive(2000, NEW_A);
  t.noteActive(3000, undefined);
  assert.equal(t.update([thread("old", 500), thread("elsewhere", 1500), thread("later", 3500)], new Set([NEW_A]), 4000), false);
  assert.equal(t.tabOf("old"), undefined);
  assert.equal(t.tabOf("elsewhere"), undefined);
  assert.equal(t.tabOf("later"), undefined);
  assert.equal(t.sessionOf(NEW_A), undefined);
});

test("a new chat started again in the same tab moves the tab to the newer thread", () => {
  const t = new CodexTabTracker();
  t.noteActive(1000, NEW_A);
  t.update([thread("first", 1100)], new Set([NEW_A]), 1200);
  assert.equal(t.update([thread("first", 1100), thread("second", 1300)], new Set([NEW_A]), 1400), true);
  assert.equal(t.sessionOf(NEW_A), "second");
  assert.equal(t.tabOf("first"), undefined);
  assert.equal(t.update([thread("first", 1100), thread("second", 1300)], new Set([NEW_A]), 1500), false);
});

test("closing a tab drops its thread, and a reopened tab of that resource starts unbound", () => {
  const t = new CodexTabTracker();
  t.noteActive(1000, NEW_A);
  t.update([thread("x", 1100)], new Set([NEW_A]), 1200);
  t.noteActive(1300, undefined);
  assert.equal(t.update([thread("x", 1100)], new Set(), 1400), true);
  assert.equal(t.tabOf("x"), undefined);
  // VS Code restores the resource after a reload; Codex shows a new chat in it.
  assert.equal(t.update([thread("x", 1100)], new Set([NEW_A]), 1500), false);
  assert.equal(t.sessionOf(NEW_A), undefined);
});

test("old history is forgotten, but the tab in front since then is still known", () => {
  const t = new CodexTabTracker();
  t.noteActive(1000, NEW_A);
  t.update([], new Set([NEW_A]), 1000 + 60 * 60_000);
  t.update([thread("x", 1000 + 60 * 60_000 - 5)], new Set([NEW_A]), 1000 + 60 * 60_000 + 10);
  assert.equal(t.tabOf("x"), NEW_A);
});
