import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "@agent-sessions/core";
import { SessionMarks, type KeyValueStore } from "../state/marks.js";
import { SessionStore, type SessionRow } from "../state/sessionStore.js";
import { attentionBadge, attentionRows, attentionSnapshot, AttentionTracker, BURST_LIMIT, burstTitle, gainedAttention, notificationPlan, toastText } from "../state/attention.js";

class MemStore implements KeyValueStore {
  data = new Map<string, unknown>();
  get<T>(key: string) { return this.data.get(key) as T | undefined; }
  update(key: string, value: unknown) { if (value === undefined) this.data.delete(key); else this.data.set(key, value); }
}
const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ agent: "claude", id, title: id, cwd: "/w", createdAt: 1, updatedAt: 100, status: "idle", ...over });
const row = (machineId: string, session: SessionInfo, over: Partial<SessionRow> = {}): SessionRow => ({ machineId, session, hidden: false, unread: true, pinned: false, ...over });
const never = () => false;

test("attentionRows keeps unread, visible sessions of every machine, newest first", () => {
  const rows = new Map<string, SessionRow[]>([
    ["local", [row("local", s("a", { updatedAt: 100 })), row("local", s("b", { updatedAt: 300 }), { unread: false }), row("local", s("c", { updatedAt: 200 }), { hidden: true })]],
    ["box", [row("box", s("d", { updatedAt: 250 })), row("box", s("e", { updatedAt: 400, status: "running" }))]],
  ]);
  assert.deepEqual(attentionRows(rows, never).map((r) => `${r.machineId}/${r.session.id}`), ["box/d", "local/a"]);
});

test("attentionRows drops sessions of hidden folders", () => {
  const rows = new Map<string, SessionRow[]>([["local", [row("local", s("a", { cwd: "/hidden" })), row("local", s("b", { cwd: "/w" }))]]]);
  const hidden = (machineId: string, cwd: string) => machineId === "local" && cwd === "/hidden";
  assert.deepEqual(attentionRows(rows, hidden).map((r) => r.session.id), ["b"]);
});

test("attentionBadge counts sessions and is absent at zero", () => {
  assert.equal(attentionBadge(0), undefined);
  assert.deepEqual(attentionBadge(1), { value: 1, tooltip: "1 session needs attention" });
  assert.deepEqual(attentionBadge(3), { value: 3, tooltip: "3 sessions need attention" });
});

test("tracker notifies once per updatedAt and again after more activity", () => {
  const mem = new MemStore();
  const tracker = new AttentionTracker(new SessionMarks(mem));
  const a = row("local", s("a", { updatedAt: 100 }));
  assert.deepEqual(tracker.toNotify([a]).map((r) => r.session.id), ["a"]);
  assert.equal(mem.get("notified/local/claude:a"), 100);
  assert.deepEqual(tracker.toNotify([a]), []);
  const later = row("local", s("a", { updatedAt: 200 }));
  assert.deepEqual(tracker.toNotify([later]).map((r) => r.session.id), ["a"]);
  assert.equal(mem.get("notified/local/claude:a"), 200);
});

test("tracker is quiet about a session marked unread by hand", () => {
  const marks = new SessionMarks(new MemStore());
  const store = new SessionStore(marks);
  const a = s("a", { updatedAt: 100 });
  store.setMachineSessions("local", new Map([["claude:a", a]]));
  store.markUnread("local", a);
  const rows = store.rows("local");
  assert.equal(rows[0].unread, true);
  assert.deepEqual(new AttentionTracker(marks).toNotify(rows), []);
});

test("tracker tells sessions of different machines apart", () => {
  const tracker = new AttentionTracker(new SessionMarks(new MemStore()));
  const both = [row("local", s("a")), row("box", s("a"))];
  assert.equal(tracker.toNotify(both).length, 2);
  assert.equal(tracker.toNotify(both).length, 0);
});

test("seedIfNeeded marks the current rows as announced once, without announcing", () => {
  const mem = new MemStore();
  const tracker = new AttentionTracker(new SessionMarks(mem));
  const a = row("local", s("a", { updatedAt: 100 }));
  const b = row("box", s("b", { updatedAt: 200 }));
  assert.equal(tracker.seedIfNeeded([a, b]), true);
  assert.equal(mem.get("notified/local/claude:a"), 100);
  assert.equal(mem.get("notified/box/claude:b"), 200);
  assert.equal(mem.get("attention/seeded"), true);
  assert.deepEqual(tracker.toNotify([a, b]), []);
  const c = row("local", s("c", { updatedAt: 300 }));
  assert.equal(tracker.seedIfNeeded([a, b, c]), false, "seeding happens once");
  assert.deepEqual(tracker.toNotify([a, b, c]).map((r) => r.session.id), ["c"]);
});

test("gainedAttention sees a new session or more activity, not a shrinking set", () => {
  const a = row("local", s("a", { updatedAt: 100 }));
  const b = row("local", s("b", { updatedAt: 100 }));
  assert.equal(gainedAttention(new Map(), []), false);
  assert.equal(gainedAttention(new Map(), [a]), true);
  const prev = attentionSnapshot([a, b]);
  assert.deepEqual([...prev], [["local/claude:a", 100], ["local/claude:b", 100]]);
  assert.equal(gainedAttention(prev, [a, b]), false);
  assert.equal(gainedAttention(prev, [a]), false);
  assert.equal(gainedAttention(prev, [a, row("local", s("b", { updatedAt: 150 }))]), true);
  assert.equal(gainedAttention(prev, [a, row("box", s("b", { updatedAt: 100 }))]), true);
});

test("notificationPlan announces each session up to the burst limit, then one summary", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => row("local", s(`r${i}`)));
  assert.equal(BURST_LIMIT, 3);
  assert.deepEqual(notificationPlan([]), { kind: "each", rows: [] });
  const three = rows(3);
  assert.deepEqual(notificationPlan(three), { kind: "each", rows: three });
  assert.deepEqual(notificationPlan(rows(4)), { kind: "summary", count: 4 });
  assert.equal(burstTitle(4), "4 sessions need attention");
});

test("toastText drops brackets and shortens a long title", () => {
  assert.equal(toastText("Fix [tests]", "box · /w/[x]"), "Fix tests (box · /w/x)");
  const long = "x".repeat(100);
  const text = toastText(long, "here");
  assert.equal(text, `${"x".repeat(79)}… (here)`);
  assert.equal(toastText("x".repeat(80), "here"), `${"x".repeat(80)} (here)`);
});
