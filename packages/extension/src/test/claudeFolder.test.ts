import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@agent-sessions/core";
import { claudeFindsSession, isDirectory, isNewSessionRequest, isWindowFolder, newSessionRequest, PENDING_OPEN_TTL_MS, pendingSessionFor, remoteFolderUri } from "../claudeFolder.js";

const noWorktrees = async () => [];
const session = (cwd: string): SessionInfo => ({ agent: "claude", id: "a", title: "a", cwd, createdAt: 1, updatedAt: 1, status: "idle" });

test("finds a session of a window folder, also through a symlink or a trailing slash", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-folder-"));
  const ws = join(root, "ws");
  await mkdir(ws);
  await symlink(ws, join(root, "link"));
  assert.equal(await claudeFindsSession(ws, [ws], noWorktrees), true);
  assert.equal(await claudeFindsSession(`${ws}/`, [join(root, "link")], noWorktrees), true);
});

test("does not find a session of a subfolder or another folder", async () => {
  assert.equal(await claudeFindsSession("/w/sub", ["/w"], noWorktrees), false);
  assert.equal(await claudeFindsSession("/other", ["/w"], noWorktrees), false);
  assert.equal(await claudeFindsSession("/other", [], noWorktrees), false);
});

test("finds a session of a git worktree of a window folder", async () => {
  const worktrees = async (dir: string) => (dir === "/w" ? ["/w", "/tmp/wt"] : []);
  assert.equal(await claudeFindsSession("/tmp/wt", ["/w"], worktrees), true);
});

test("in a multi-root window only the first folder counts, as Claude Code runs in it", async () => {
  const worktrees = async (dir: string) => (dir === "/second" ? ["/second", "/tmp/wt2"] : []);
  assert.equal(await claudeFindsSession("/second", ["/first", "/second"], worktrees), false);
  assert.equal(await claudeFindsSession("/tmp/wt2", ["/first", "/second"], worktrees), false);
  assert.equal(await claudeFindsSession("/first", ["/first", "/second"], worktrees), true);
  assert.equal(await isWindowFolder("/second", ["/first", "/second"]), false);
  assert.equal(await isWindowFolder("/first", ["/first", "/second"]), true);
});

test("lets Claude Code try when the cwd is unknown", async () => {
  assert.equal(await claudeFindsSession("", ["/w"], noWorktrees), true);
});

test("isDirectory is false for a missing path", async () => {
  assert.equal(await isDirectory(tmpdir()), true);
  assert.equal(await isDirectory(join(tmpdir(), "no-such-dir-agent-sessions")), false);
});

test("a pending session opens only in a window on its folder and only while fresh", async () => {
  const s = session("/w");
  assert.equal(await pendingSessionFor({ session: s, at: 1000 }, ["/w"], 2000), s);
  assert.equal(await pendingSessionFor({ session: s, at: 1000 }, ["/other"], 2000), undefined);
  assert.equal(await pendingSessionFor({ session: s, at: 1000 }, ["/w"], 1000 + PENDING_OPEN_TTL_MS + 1), undefined);
  assert.equal(await pendingSessionFor({ session: s, at: 1000 }, ["/w"], 500), undefined);
  assert.equal(await pendingSessionFor(undefined, ["/w"], 2000), undefined);
});

test("a window folder matches exactly, also through a symlink or a trailing slash", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-folder-"));
  const ws = join(root, "ws");
  await mkdir(join(ws, "sub"), { recursive: true });
  await symlink(ws, join(root, "link"));
  assert.equal(await isWindowFolder(ws, [ws]), true);
  assert.equal(await isWindowFolder(`${ws}/`, [join(root, "link")]), true);
  assert.equal(await isWindowFolder(join(ws, "sub"), [ws]), false);
  assert.equal(await isWindowFolder(root, [ws]), false);
  assert.equal(await isWindowFolder(ws, []), false);
  assert.equal(await isWindowFolder("", [ws]), false);
});

test("a new-session request is a session without an id", () => {
  const r = newSessionRequest("codex", "/w", 5);
  assert.deepEqual(r, { agent: "codex", id: "", title: "", cwd: "/w", createdAt: 5, updatedAt: 5, status: "unknown" });
  assert.equal(isNewSessionRequest(r), true);
  assert.equal(isNewSessionRequest(session("/w")), false);
});

test("a pending new-session request reaches the window on its folder", async () => {
  const r = newSessionRequest("claude", "/w", 1000);
  assert.equal(await pendingSessionFor({ session: r, at: 1000 }, ["/w"], 2000), r);
  assert.equal(await pendingSessionFor({ session: r, at: 1000 }, ["/other"], 2000), undefined);
});

test("remoteFolderUri addresses the ssh host and keeps the path readable", () => {
  assert.equal(remoteFolderUri("dev-box", "/home/me/proj"), "vscode-remote://ssh-remote+dev-box/home/me/proj");
  assert.equal(remoteFolderUri("dev-box", "/home/me/my proj"), "vscode-remote://ssh-remote+dev-box/home/me/my%20proj");
});
