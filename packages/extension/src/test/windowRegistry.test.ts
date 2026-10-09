import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWindowForFolder, removeWindowRecord, windowRecordTarget, writeWindowRecord, type WindowRecord } from "../state/windowRegistry.js";

const withDir = async (fn: (root: string, dir: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "window-registry-")));
  try {
    await fn(root, join(root, "windows"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const NOW = 1_000_000_000_000;
const opts = (alive: readonly number[] = [], canonical = async (p: string) => p) => ({
  isAlive: (pid: number) => alive.includes(pid),
  canonical,
  now: NOW,
});

test("a written record is found by its first folder", () =>
  withDir(async (_root, dir) => {
    const record: WindowRecord = { pid: 11, folders: ["/a", "/b"], updatedAt: NOW };
    await writeWindowRecord(dir, record);
    assert.deepEqual(await readdir(dir), ["11.json"]);
    assert.deepEqual(await findWindowForFolder(dir, "/a", opts([11])), record);
    assert.equal(await findWindowForFolder(dir, "/c", opts([11])), undefined);
    await removeWindowRecord(dir, 11);
    await removeWindowRecord(dir, 11);
    assert.equal(await findWindowForFolder(dir, "/a", opts([11])), undefined);
  }));

test("a record of a dead window is deleted and skipped", () =>
  withDir(async (_root, dir) => {
    await writeWindowRecord(dir, { pid: 11, folders: ["/a"], updatedAt: NOW });
    await writeWindowRecord(dir, { pid: 12, folders: ["/a"], updatedAt: NOW - 1 });
    assert.equal((await findWindowForFolder(dir, "/a", opts([12])))?.pid, 12);
    assert.deepEqual(await readdir(dir), ["12.json"]);
  }));

test("old and unparsable records are skipped", () =>
  withDir(async (_root, dir) => {
    await writeWindowRecord(dir, { pid: 11, folders: ["/a"], updatedAt: NOW - 8 * 24 * 3600_000 });
    await writeFile(join(dir, "12.json"), "{not json");
    await writeFile(join(dir, "13.json"), JSON.stringify({ pid: 13, folders: "/a", updatedAt: NOW }));
    assert.equal(await findWindowForFolder(dir, "/a", opts([11, 12, 13])), undefined);
  }));

test("a multi-root window wins over a newer single-folder one", () =>
  withDir(async (_root, dir) => {
    await writeWindowRecord(dir, { pid: 11, folders: ["/a"], updatedAt: NOW });
    await writeWindowRecord(dir, { pid: 12, workspaceFile: "/w/old.code-workspace", folders: ["/x", "/a"], updatedAt: NOW - 20 });
    await writeWindowRecord(dir, { pid: 13, workspaceFile: "/w/new.code-workspace", folders: ["/a", "/y"], updatedAt: NOW - 10 });
    const found = await findWindowForFolder(dir, "/a", opts([11, 12, 13]));
    assert.equal(found?.pid, 13);
    assert.equal(windowRecordTarget(found!, "/a"), "/w/new.code-workspace");
    const single = await findWindowForFolder(dir, "/a", opts([11]));
    assert.equal(windowRecordTarget(single!, "/a"), "/a");
  }));

test("a window whose first folder is another one does not count, as Claude Code runs in the first folder", () =>
  withDir(async (_root, dir) => {
    await writeWindowRecord(dir, { pid: 12, workspaceFile: "/w/old.code-workspace", folders: ["/x", "/a"], updatedAt: NOW });
    assert.equal(await findWindowForFolder(dir, "/a", opts([12])), undefined);
  }));

test("folders compare by their canonical paths", () =>
  withDir(async (root, dir) => {
    const real = join(root, "project");
    const link = join(root, "link");
    await mkdir(real);
    await symlink(real, link);
    await writeWindowRecord(dir, { pid: 11, folders: [link], updatedAt: NOW });
    const canonical = (p: string) => realpath(p).catch(() => p);
    assert.equal((await findWindowForFolder(dir, real, opts([11], canonical)))?.pid, 11);
    assert.equal(await findWindowForFolder(dir, real, opts([11])), undefined);
  }));

test("a missing directory has no windows", () =>
  withDir(async (_root, dir) => {
    assert.equal(await findWindowForFolder(dir, "/a", opts([11])), undefined);
    await removeWindowRecord(dir, 11);
  }));
