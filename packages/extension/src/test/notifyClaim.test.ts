import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimNotification, pruneNotifyClaims } from "../tray/notifyClaim.js";

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "notify-claim-"));
  try {
    await fn(join(root, "notified"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("only the first claim of a session at an updatedAt wins", () =>
  withDir(async (dir) => {
    assert.equal(await claimNotification(dir, "local/claude:a", 100), true);
    assert.equal(await claimNotification(dir, "local/claude:a", 100), false);
    assert.equal(await claimNotification(dir, "local/claude:a", 200), true);
    assert.equal(await claimNotification(dir, "box/claude:a", 100), true);
    assert.equal((await readdir(dir)).length, 3);
  }));

test("concurrent claims of one session have one winner", () =>
  withDir(async (dir) => {
    const results = await Promise.all([1, 2, 3, 4].map(() => claimNotification(dir, "local/claude:a", 100)));
    assert.equal(results.filter(Boolean).length, 1);
  }));

test("pruneNotifyClaims removes claims older than the limit", () =>
  withDir(async (dir) => {
    await claimNotification(dir, "local/claude:old", 1);
    await claimNotification(dir, "local/claude:new", 2);
    const [oldName] = (await readdir(dir)).filter((n) => n.endsWith("-1"));
    const now = Date.now();
    const old = new Date(now - 8 * 24 * 3600_000);
    await utimes(join(dir, oldName), old, old);
    await writeFile(join(dir, "unrelated"), "");
    assert.equal(await pruneNotifyClaims(dir, now, 7 * 24 * 3600_000), 1);
    assert.equal((await readdir(dir)).includes(oldName), false);
    assert.equal((await readdir(dir)).length, 2);
  }));

test("pruneNotifyClaims of a missing directory does nothing", () =>
  withDir(async (dir) => {
    assert.equal(await pruneNotifyClaims(dir, Date.now(), 1000), 0);
  }));
