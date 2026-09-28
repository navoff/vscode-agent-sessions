import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeLiveEntry, readClaudeRegistry } from "../claude/registry.js";

const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ pid: 100, sessionId: "s1", cwd: "/w", status: "busy", updatedAt: 10, statusUpdatedAt: 10, ...over });

test("parseClaudeLiveEntry reads a valid entry", () => {
  const e = parseClaudeLiveEntry(entry());
  assert.deepEqual(e, { pid: 100, sessionId: "s1", cwd: "/w", status: "busy", updatedAt: 10, statusUpdatedAt: 10 });
});

test("parseClaudeLiveEntry rejects garbage and unknown status", () => {
  assert.equal(parseClaudeLiveEntry("not json"), undefined);
  assert.equal(parseClaudeLiveEntry(entry({ status: "weird" })), undefined);
  assert.equal(parseClaudeLiveEntry(entry({ pid: "100" })), undefined);
});

test("readClaudeRegistry keeps only alive pids and newest per session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-reg-"));
  await writeFile(join(dir, "100.json"), entry({ pid: 100, updatedAt: 10 }));
  await writeFile(join(dir, "101.json"), entry({ pid: 101, updatedAt: 20, status: "idle" }));
  await writeFile(join(dir, "102.json"), entry({ pid: 102, sessionId: "s2" }));
  await writeFile(join(dir, "notes.txt"), "ignore");
  const reg = await readClaudeRegistry(dir, (pid) => pid !== 102);
  assert.equal(reg.size, 1);
  assert.equal(reg.get("s1")?.pid, 101);
  assert.equal(reg.get("s1")?.status, "idle");
});

test("readClaudeRegistry returns empty map for missing dir", async () => {
  const reg = await readClaudeRegistry("/nonexistent/dir", () => true);
  assert.equal(reg.size, 0);
});
