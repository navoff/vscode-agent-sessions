import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "@agent-sessions/core";
import type { SessionRow } from "../state/sessionStore.js";
import { claudeTabLabel, codexTabSessionId, pickViewed, tabCandidates } from "../state/viewedSession.js";

const row = (id: string, over: Partial<SessionInfo> = {}, unread = true): SessionRow => ({
  machineId: "local",
  session: { agent: "claude", id, title: id, cwd: "/w", createdAt: 1, updatedAt: 100, status: "idle", ...over },
  hidden: false,
  unread,
  pinned: false,
});
const ids = (rows: SessionRow[]) => rows.map((r) => r.session.id);

test("a Claude tab label is the title, cut to 24 characters and an ellipsis past 25", () => {
  assert.equal(claudeTabLabel("short title"), "short title");
  assert.equal(claudeTabLabel("x".repeat(25)), "x".repeat(25));
  assert.equal(claudeTabLabel("vscode_ai_sessions уведомление не сбрасывается"), "vscode_ai_sessions уведо…");
});

test("a Claude tab matches the sessions whose title gives its label", () => {
  const rows = [
    row("a", { title: "vscode_ai_sessions уведомление не сбрасывается" }),
    row("b", { title: "vscode_ai_sessions уведомление о другом" }),
    row("c", { title: "another session" }),
    row("d", { agent: "codex", title: "vscode_ai_sessions уведомление не сбрасывается" }),
  ];
  assert.deepEqual(ids(tabCandidates({ agent: "claude", label: "vscode_ai_sessions уведо…" }, rows)), ["a", "b"]);
  assert.deepEqual(ids(tabCandidates({ agent: "claude", label: "another session" }, rows)), ["c"]);
  assert.deepEqual(ids(tabCandidates({ agent: "claude", label: "Claude Code" }, rows)), []);
});

test("a Codex tab matches the session of its id", () => {
  const rows = [row("a"), row("a", { agent: "codex" }), row("b", { agent: "codex" })];
  const found = tabCandidates({ agent: "codex", sessionId: "a" }, rows);
  assert.deepEqual(found.map((r) => `${r.session.agent}:${r.session.id}`), ["codex:a"]);
});

test("the session id of a Codex tab comes from its URI path", () => {
  assert.equal(codexTabSessionId("/local/019a-b"), "019a-b");
  assert.equal(codexTabSessionId("/local/"), undefined);
  assert.equal(codexTabSessionId("/remote/019a-b"), undefined);
  assert.equal(codexTabSessionId("/local/a/b"), undefined);
});

test("one candidate is the viewed session; several are told apart by a live process", () => {
  const live = { pid: 1, statusUpdatedAt: 1 };
  assert.equal(pickViewed([]), undefined);
  assert.equal(pickViewed([row("a")])?.session.id, "a");
  assert.equal(pickViewed([row("a"), row("b", { live })])?.session.id, "b");
  assert.equal(pickViewed([row("a"), row("b")]), undefined);
  assert.equal(pickViewed([row("a", { live }), row("b", { live })]), undefined);
});
