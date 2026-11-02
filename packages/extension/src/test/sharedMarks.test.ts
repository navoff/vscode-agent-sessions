import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { SharedMarksStore } from "../state/sharedMarks.js";
import { SessionMarks } from "../state/marks.js";

const legacy = (data: Record<string, unknown> = {}) => ({
  keys: () => Object.keys(data),
  get: <T>(key: string) => data[key] as T | undefined,
});
const fileFor = (dir: string, key: string) => join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
const withStores = async (fn: (dir: string, open: (data?: Record<string, unknown>, options?: Parameters<typeof SharedMarksStore.open>[2]) => Promise<SharedMarksStore>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "shared-marks-"));
  const stores: SharedMarksStore[] = [];
  try {
    await fn(join(root, "marks"), async (data = {}, options = {}) => {
      const store = await SharedMarksStore.open(join(root, "marks"), legacy(data), options);
      stores.push(store);
      return store;
    });
  } finally {
    for (const store of stores) store.dispose();
    await rm(root, { recursive: true, force: true });
  }
};

// A whole-snapshot write lets the notification from window B erase these hides.
test("concurrent windows preserve a batch of hides alongside seen and notification updates", () => withStores(async (_dir, open) => {
  const a = await open(), b = await open();
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 15; i++) writes.push(a.update(`hidden/local/codex:session-${i}`, true));
  writes.push(b.update("seen/local/codex:other", 200), b.update("notified/local/codex:other", 200));
  await Promise.all(writes);
  const restarted = await open();
  const marks = new SessionMarks(restarted);
  for (let i = 0; i < 15; i++) assert.equal(marks.isHidden(`local/codex:session-${i}`), true);
  assert.equal(marks.lastSeen("local/codex:other"), 200);
  assert.equal(marks.lastNotified("local/codex:other"), 200);
}));

// Re-importing a stale globalState must never undo an unhide, unpin or forget.
test("migration preserves every old mark and never resurrects a removed mark", () => withStores(async (_dir, open) => {
  const old = { "hidden/local/codex:a": true, "pinned/local/codex:a": true, "seen/local/codex:a": 100, "notified/local/codex:a": 90, "hiddenProject/local//work": true, "attention/seeded": true };
  const a = await open(old);
  for (const [key, value] of Object.entries(old)) assert.equal(a.get(key), value);
  await a.update("hidden/local/codex:a", undefined);
  await a.update("seen/local/codex:a", 200);
  const restarted = await open(old);
  assert.equal(restarted.get("hidden/local/codex:a"), undefined);
  assert.equal(restarted.get("seen/local/codex:a"), 200);
  assert.equal(restarted.get("pinned/local/codex:a"), true);
}));

test("simultaneous migrations cannot replace an existing mark", () => withStores(async (_dir, open) => {
  await Promise.all([open({ "hidden/local/codex:a": true }), open({ "seen/local/codex:b": 123 })]);
  const store = await open();
  await store.update("hidden/local/codex:a", undefined);
  await Promise.all([open({ "hidden/local/codex:a": true }), open({ "hidden/local/codex:a": true })]);
  const restarted = await open();
  assert.equal(restarted.get("hidden/local/codex:a"), undefined);
  assert.equal(restarted.get("seen/local/codex:b"), 123);
}));

test("a running window refreshes its marks after another window writes", () => withStores(async (_dir, open) => {
  let changed!: () => void;
  const notified = new Promise<void>((resolve) => { changed = resolve; });
  const a = await open({}, { onChange: () => { if (a.get("hidden/local/codex:a") === true) changed(); } });
  const b = await open();
  await b.update("hidden/local/codex:a", true);
  await Promise.race([notified, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("other window did not refresh")), 3000); timer.unref(); })]);
  assert.equal(a.get("hidden/local/codex:a"), true);
}));

test("rapid updates of one key persist in user action order", () => withStores(async (dir, open) => {
  const store = await open();
  await Promise.all([store.update("hidden/local/codex:a", true), store.update("hidden/local/codex:a", undefined), store.update("hidden/local/codex:a", true)]);
  assert.equal((await open()).get("hidden/local/codex:a"), true);
  const files = await readdir(dir);
  assert.equal(files.filter((name) => name.endsWith(".tmp")).length, 0);
}));

test("shutdown waits for the synchronous mark actions to reach disk", () => withStores(async (_dir, open) => {
  const store = await open();
  const marks = new SessionMarks(store);
  marks.setHidden("local/codex:a", true);
  marks.setLastSeen("local/codex:b", 123);
  await store.flush();
  store.dispose();
  const restarted = await open();
  assert.equal(restarted.get("hidden/local/codex:a"), true);
  assert.equal(restarted.get("seen/local/codex:b"), 123);
}));

test("a failed write reports the error and restores the persisted value in memory", () => withStores(async (dir, open) => {
  const errors: unknown[] = [];
  const store = await open({}, { onError: (error) => { errors.push(error); } });
  const key = "hidden/local/codex:a";
  // A directory at the record path makes atomic rename fail, on every test host.
  await mkdir(fileFor(dir, key));
  await assert.rejects(store.update(key, true));
  assert.equal(errors.length, 1);
  assert.equal(store.get(key), undefined);
  assert.equal((await readdir(dir)).filter((name) => name.endsWith(".tmp")).length, 0);
}));

test("a damaged record stops activation instead of silently losing its mark", () => withStores(async (dir, open) => {
  await mkdir(dir, { recursive: true });
  await writeFile(fileFor(dir, "hidden/local/codex:a"), "{broken");
  await assert.rejects(open(), /mark/i);
  assert.equal(await readFile(fileFor(dir, "hidden/local/codex:a"), "utf8"), "{broken");
}));

test("a slow older filesystem refresh cannot undo a newer mark from another window", () => withStores(async (dir, open) => {
  const key = "hidden/local/codex:a";
  const store = await open({ [key]: false });
  await delay(100); // Let the initial watcher refresh finish before delaying a read.
  const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.readFile;
  let release!: () => void, started!: () => void;
  const paused = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pauseNext = true;
  const reader = mock.method(fs, "readFile", async (path: Parameters<typeof readFile>[0], options?: Parameters<typeof readFile>[1]) => {
    const value = await original(path, options);
    if (path === fileFor(dir, key) && pauseNext) {
      pauseNext = false;
      started();
      await gate;
    }
    return value;
  });
  syncBuiltinESMExports();
  try {
    await writeFile(fileFor(dir, key), JSON.stringify({ key, value: false }));
    await Promise.race([paused, delay(3000).then(() => { throw new Error("watcher did not read the mark"); })]);
    await writeFile(fileFor(dir, key), JSON.stringify({ key, value: true }));
    await delay(150);
    release();
    await delay(150);
    assert.equal(store.get(key), true);
  } finally {
    release();
    reader.mock.restore();
    syncBuiltinESMExports();
  }
}));
