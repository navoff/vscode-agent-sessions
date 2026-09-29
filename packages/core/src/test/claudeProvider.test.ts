import { test } from "node:test";
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider, type SdkSessionInfo } from "../claude/provider.js";

function inotifyAvailable(dir: string): boolean {
  try { watch(dir, () => {}).close(); return true; } catch { return false; }
}

const T1 = Date.parse("2026-09-29T10:00:00.000Z");
const T2 = Date.parse("2026-09-29T10:17:49.000Z");
const T3 = Date.parse("2026-09-29T12:22:00.000Z");
const jsonl = (o: object) => JSON.stringify(o) + "\n";

async function makeClaudeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-"));
  await mkdir(join(dir, "sessions"));
  await mkdir(join(dir, "projects"));
  await writeFile(
    join(dir, "sessions", "500.json"),
    JSON.stringify({ pid: 500, sessionId: "a", cwd: "/p", status: "busy", updatedAt: 900, statusUpdatedAt: 900 }),
  );
  await mkdir(join(dir, "projects", "-w"));
  await writeFile(
    join(dir, "projects", "-w", "a.jsonl"),
    jsonl({ type: "user", timestamp: new Date(T1).toISOString() }) +
      jsonl({ type: "assistant", timestamp: new Date(T2).toISOString() }) +
      jsonl({ type: "last-prompt", lastPrompt: "x" }) +
      jsonl({ type: "cost-state" }),
  );
  return dir;
}

const sdk: SdkSessionInfo[] = [
  { sessionId: "a", summary: "Sum A", customTitle: "Title A", cwd: "/p", createdAt: 1, lastModified: 100 },
  { sessionId: "b", summary: "", firstPrompt: "first words", cwd: "/q", lastModified: 200 },
];

test("snapshot merges SDK sessions with the live registry", async () => {
  const claudeDir = await makeClaudeDir();
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdk, isAlive: () => true });
  const list = await p.snapshot();
  const a = list.find((s) => s.id === "a")!;
  const b = list.find((s) => s.id === "b")!;
  assert.equal(a.status, "running");
  assert.equal(a.title, "Title A");
  assert.equal(a.updatedAt, T2);
  assert.deepEqual(a.live, { pid: 500, statusUpdatedAt: 900 });
  assert.equal(b.status, "idle");
  assert.equal(b.title, "first words");
  assert.equal(b.createdAt, 200);
  assert.equal(b.live, undefined);
});

test("snapshot uses the last message time, not file mtime or registry time", async () => {
  const claudeDir = await makeClaudeDir();
  const late = Date.parse("2030-01-01T00:00:00Z");
  const p = new ClaudeProvider({
    claudeDir,
    listSessions: async () => [{ sessionId: "a", summary: "s", lastModified: late }],
    isAlive: () => true,
  });
  assert.equal((await p.snapshot())[0]!.updatedAt, T2);
});

test("snapshot falls back to lastModified without a session file", async () => {
  const claudeDir = await makeClaudeDir();
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdk, isAlive: () => true });
  const list = await p.snapshot();
  assert.equal(list.find((s) => s.id === "b")!.updatedAt, 200);
});

test("snapshot picks up an appended message", async () => {
  const claudeDir = await makeClaudeDir();
  const p = new ClaudeProvider({
    claudeDir,
    listSessions: async () => [{ sessionId: "a", summary: "s", lastModified: 1 }],
    isAlive: () => true,
  });
  assert.equal((await p.snapshot())[0]!.updatedAt, T2);
  await appendFile(join(claudeDir, "projects", "-w", "a.jsonl"), jsonl({ type: "assistant", timestamp: new Date(T3).toISOString() }));
  assert.equal((await p.snapshot())[0]!.updatedAt, T3);
});

test("snapshot logs and rethrows an SDK failure", async () => {
  const claudeDir = await makeClaudeDir();
  const logs: string[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => { throw new Error("boom"); }, log: (m) => logs.push(m) });
  await assert.rejects(p.snapshot(), /boom/);
  assert.ok(logs.some((l) => l.includes("boom")));
});

test("watch fires on registry changes", async (t) => {
  const claudeDir = await makeClaudeDir();
  if (!inotifyAvailable(claudeDir)) { t.skip("inotify instances exhausted on this machine (fs.watch ENOSPC)"); return; }
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => [] });
  let fired = 0;
  const w = p.watch(() => { fired++; });
  await writeFile(join(claudeDir, "sessions", "501.json"), "{}");
  await new Promise((r) => setTimeout(r, 200));
  w.dispose();
  assert.ok(fired > 0);
});

test("watch tolerates a missing directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-"));
  await mkdir(join(dir, "sessions"));
  const logs: string[] = [];
  const p = new ClaudeProvider({ claudeDir: dir, listSessions: async () => [], log: (m) => logs.push(m) });
  let w: { dispose: () => void } | undefined;
  assert.doesNotThrow(() => {
    w = p.watch(() => {});
  });
  assert.ok(logs.some((l) => l.includes("projects")));
  w?.dispose();
});

test("watch fires on project file changes", async (t) => {
  const claudeDir = await makeClaudeDir();
  if (!inotifyAvailable(claudeDir)) { t.skip("inotify instances exhausted on this machine (fs.watch ENOSPC)"); return; }
  const projectDir = join(claudeDir, "projects", "-home-u-proj");
  await mkdir(projectDir);
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => [] });
  let fired = 0;
  const w = p.watch(() => { fired++; });
  await writeFile(join(projectDir, "abc.jsonl"), "{}");
  await new Promise((r) => setTimeout(r, 200));
  w.dispose();
  assert.ok(fired > 0);
});
