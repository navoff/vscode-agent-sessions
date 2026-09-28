import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider, type SdkSessionInfo } from "../claude/provider.js";

async function makeClaudeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-"));
  await mkdir(join(dir, "sessions"));
  await mkdir(join(dir, "projects"));
  await writeFile(
    join(dir, "sessions", "500.json"),
    JSON.stringify({ pid: 500, sessionId: "a", cwd: "/p", status: "busy", updatedAt: 900, statusUpdatedAt: 900 }),
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
  assert.equal(a.updatedAt, 900);
  assert.deepEqual(a.live, { pid: 500, statusUpdatedAt: 900 });
  assert.equal(b.status, "idle");
  assert.equal(b.title, "first words");
  assert.equal(b.createdAt, 200);
  assert.equal(b.live, undefined);
});

test("snapshot survives an SDK failure", async () => {
  const claudeDir = await makeClaudeDir();
  const logs: string[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => { throw new Error("boom"); }, log: (m) => logs.push(m) });
  assert.deepEqual(await p.snapshot(), []);
  assert.ok(logs.some((l) => l.includes("boom")));
});

test("watch fires on registry changes", async () => {
  const claudeDir = await makeClaudeDir();
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => [] });
  let fired = 0;
  const w = p.watch(() => { fired++; });
  await writeFile(join(claudeDir, "sessions", "501.json"), "{}");
  await new Promise((r) => setTimeout(r, 200));
  w.dispose();
  assert.ok(fired > 0);
});
