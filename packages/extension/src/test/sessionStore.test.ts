import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "@agent-sessions/core";
import { SessionMarks, type KeyValueStore } from "../state/marks.js";
import { isSafeSessionId, SessionStore } from "../state/sessionStore.js";

class MemStore implements KeyValueStore {
  data = new Map<string, unknown>();
  get<T>(key: string) { return this.data.get(key) as T | undefined; }
  update(key: string, value: unknown) { if (value === undefined) this.data.delete(key); else this.data.set(key, value); }
}
const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ agent: "claude", id, title: id, cwd: "/w", createdAt: 1, updatedAt: 100, status: "idle", ...over });
const map = (...list: SessionInfo[]) => new Map(list.map((x) => [`${x.agent}:${x.id}`, x]));

test("first appearance is read, later activity is unread", () => {
  const store = new SessionStore(new SessionMarks(new MemStore()));
  store.setMachineSessions("local", map(s("a")));
  assert.equal(store.rows("local")[0].unread, false);
  store.setMachineSessions("local", map(s("a", { updatedAt: 200 })));
  assert.equal(store.rows("local")[0].unread, true);
});

test("running sessions are never unread; markRead clears; markUnread sets", () => {
  const store = new SessionStore(new SessionMarks(new MemStore()));
  store.setMachineSessions("local", map(s("a")));
  store.setMachineSessions("local", map(s("a", { updatedAt: 200, status: "running" })));
  assert.equal(store.rows("local")[0].unread, false);
  store.setMachineSessions("local", map(s("a", { updatedAt: 300 })));
  assert.equal(store.rows("local")[0].unread, true);
  store.markRead("local", s("a", { updatedAt: 300 }), 400);
  assert.equal(store.rows("local")[0].unread, false);
  store.markUnread("local", s("a", { updatedAt: 300 }));
  assert.equal(store.rows("local")[0].unread, true);
});

test("hidden flag is stored per machine and session", () => {
  const mem = new MemStore();
  const store = new SessionStore(new SessionMarks(mem));
  store.setMachineSessions("local", map(s("a")));
  store.setMachineSessions("hetzner", map(s("a")));
  store.setHidden("local", s("a"), true);
  assert.equal(store.rows("local")[0].hidden, true);
  assert.equal(store.rows("hetzner")[0].hidden, false);
  assert.equal(mem.get("hidden/local/claude:a"), true);
  store.setHidden("local", s("a"), false);
  assert.equal(mem.get("hidden/local/claude:a"), undefined);
});

test("forget drops the hidden and last-seen marks of one session only", () => {
  const mem = new MemStore();
  const store = new SessionStore(new SessionMarks(mem));
  store.setMachineSessions("local", map(s("a"), s("b")));
  store.setMachineSessions("hetzner", map(s("a")));
  store.setHidden("local", s("a"), true);
  store.forget("local", s("a"));
  assert.equal(mem.get("hidden/local/claude:a"), undefined);
  assert.equal(mem.get("seen/local/claude:a"), undefined);
  assert.equal(mem.get("seen/local/claude:b"), 100);
  assert.equal(mem.get("seen/hetzner/claude:a"), 100);
});

test("removeMachine drops rows, find returns session", () => {
  const store = new SessionStore(new SessionMarks(new MemStore()));
  store.setMachineSessions("m", map(s("a")));
  assert.equal(store.find("m", "claude:a")?.id, "a");
  assert.deepEqual(store.machineIds(), ["m"]);
  store.removeMachine("m");
  assert.deepEqual(store.rows("m"), []);
});

test("isSafeSessionId accepts uuid-like ids only", () => {
  assert.equal(isSafeSessionId("0199a1b2-c3d4-7e5f-8a9b-0123456789ab"), true);
  assert.equal(isSafeSessionId("abc_DEF-123"), true);
  for (const bad of ["", "a b", "a;rm -rf ~", "a\nb", "../x", "a/b"]) assert.equal(isSafeSessionId(bad), false, bad);
});
