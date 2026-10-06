import { test } from "node:test";
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider, type SdkSessionInfo } from "../claude/provider.js";
import { claudeProjectDirName } from "../claude/relocate.js";

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
  assert.equal(b.firstPrompt, "first words");
  // A session without a first prompt has no such field at all.
  assert.ok(!("firstPrompt" in a));
});

test("snapshot takes the first prompt with its line breaks from the transcript", async () => {
  const claudeDir = await makeClaudeDir();
  await writeFile(
    join(claudeDir, "projects", "-w", "b.jsonl"),
    jsonl({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "fix the\nmeta" }] } }) +
      jsonl({ type: "user", timestamp: new Date(T1).toISOString(), message: { content: [{ type: "image" }, { type: "text", text: "fix the\n bug  now\n\nplease" }] } }) +
      jsonl({ type: "user", timestamp: new Date(T2).toISOString(), message: { content: "second" } }),
  );
  await writeFile(join(claudeDir, "projects", "-w", "c.jsonl"), jsonl({ type: "user", message: { content: "something else" } }));
  const list: SdkSessionInfo[] = [
    { sessionId: "b", summary: "", firstPrompt: "fix the  bug  now  please", lastModified: 1 },
    { sessionId: "c", summary: "", firstPrompt: "not in  the transcript", lastModified: 1 },
  ];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => list, isAlive: () => false });
  const got = new Map((await p.snapshot()).map((s) => [s.id, s.firstPrompt]));
  assert.equal(got.get("b"), "fix the\nbug now\nplease");
  // Not found in the transcript: the SDK's one line is used.
  assert.equal(got.get("c"), "not in the transcript");
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

const ID1 = "11111111-2222-4333-8444-555555555555";
const ID2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";

/** A Claude dir with ID1 in project -w (cwd /w) and, optionally, a registry entry for it. */
async function makeDeleteDir(live?: "busy" | "idle"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-del-"));
  await mkdir(join(dir, "sessions"));
  await mkdir(join(dir, "projects", "-w"), { recursive: true });
  await writeFile(join(dir, "projects", "-w", `${ID1}.jsonl`), jsonl({ type: "user", timestamp: new Date(T1).toISOString() }));
  if (live) await writeFile(join(dir, "sessions", "700.json"), JSON.stringify({ pid: 700, sessionId: ID1, cwd: "/w", status: live, updatedAt: 1, statusUpdatedAt: 1 }));
  return dir;
}
const sdkDel: SdkSessionInfo[] = [{ sessionId: ID1, summary: "s", cwd: "/w", lastModified: 1 }];
type DelCall = [string, { dir?: string } | undefined];

test("delete calls the SDK with the session's cwd as dir", async () => {
  const claudeDir = await makeDeleteDir();
  const calls: DelCall[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, isAlive: () => true, deleteSession: async (id, o) => { calls.push([id, o]); } });
  await p.delete(ID1);
  assert.deepEqual(calls, [[ID1, undefined]]);
  await p.snapshot();
  await p.delete(ID1);
  assert.deepEqual(calls[1], [ID1, { dir: "/w" }]);
});

test("delete retries without dir when the transcript is not under the cwd's project", async () => {
  const claudeDir = await makeDeleteDir();
  const calls: DelCall[] = [];
  const p = new ClaudeProvider({
    claudeDir, listSessions: async () => sdkDel, isAlive: () => true,
    deleteSession: async (id, o) => { calls.push([id, o]); if (o?.dir) throw new Error(`Session ${id} not found in project directory for ${o.dir}`); },
  });
  await p.snapshot();
  await p.delete(ID1);
  assert.deepEqual(calls, [[ID1, { dir: "/w" }], [ID1, undefined]]);
});

test("delete refuses a session with a live Claude Code process, busy or idle", async () => {
  for (const live of ["busy", "idle"] as const) {
    const claudeDir = await makeDeleteDir(live);
    const calls: DelCall[] = [];
    const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, isAlive: () => true, deleteSession: async (id, o) => { calls.push([id, o]); } });
    await assert.rejects(p.delete(ID1), /open in Claude Code \(pid 700\); close it in Claude Code first/, live);
    assert.equal(calls.length, 0);
    // The same entry with its process gone does not count.
    const dead = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, isAlive: () => false, deleteSession: async (id, o) => { calls.push([id, o]); } });
    await dead.delete(ID1);
    assert.equal(calls.length, 1);
  }
});

test("delete refuses an id whose transcript exists in several project folders", async () => {
  const claudeDir = await makeDeleteDir();
  await mkdir(join(claudeDir, "projects", "-other"));
  await writeFile(join(claudeDir, "projects", "-other", `${ID1}.jsonl`), "{}\n");
  const calls: DelCall[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, deleteSession: async (id, o) => { calls.push([id, o]); } });
  await assert.rejects(p.delete(ID1), /transcripts in 2 project folders/);
  assert.equal(calls.length, 0);
});

test("delete rejects a non-UUID id and passes SDK errors through", async () => {
  const claudeDir = await makeDeleteDir();
  const calls: DelCall[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, deleteSession: async (id, o) => { calls.push([id, o]); } });
  for (const bad of ["../x", "-rf", "b", `${ID1}x`, ""]) await assert.rejects(p.delete(bad), /invalid Claude session id/, bad);
  assert.equal(calls.length, 0);
  await p.delete(ID1.toUpperCase());
  const failing = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, deleteSession: async () => { throw new Error(`Session ${ID2} not found`); } });
  await assert.rejects(failing.delete(ID2), /not found/);
});

type RenCall = [string, string, { dir?: string } | undefined];

test("rename calls the SDK with the trimmed title and the session's cwd as dir", async () => {
  const claudeDir = await makeDeleteDir();
  const calls: RenCall[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, renameSession: async (id, title, o) => { calls.push([id, title, o]); } });
  await p.rename(ID1, "  New name ");
  assert.deepEqual(calls, [[ID1, "New name", undefined]]);
  await p.snapshot();
  await p.rename(ID1, "Other");
  assert.deepEqual(calls[1], [ID1, "Other", { dir: "/w" }]);
});

test("rename retries without dir when the transcript is not under the cwd's project", async () => {
  const claudeDir = await makeDeleteDir();
  const calls: RenCall[] = [];
  const p = new ClaudeProvider({
    claudeDir, listSessions: async () => sdkDel,
    renameSession: async (id, title, o) => { calls.push([id, title, o]); if (o?.dir) throw new Error(`Session ${id} not found in project directory for ${o.dir}`); },
  });
  await p.snapshot();
  await p.rename(ID1, "New name");
  assert.deepEqual(calls, [[ID1, "New name", { dir: "/w" }], [ID1, "New name", undefined]]);
});

test("rename works on a session with a live Claude Code process", async () => {
  for (const live of ["busy", "idle"] as const) {
    const claudeDir = await makeDeleteDir(live);
    const calls: RenCall[] = [];
    const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, isAlive: () => true, renameSession: async (id, title, o) => { calls.push([id, title, o]); } });
    await p.rename(ID1, "New name");
    assert.equal(calls.length, 1, live);
  }
});

test("rename refuses an id whose transcript exists in several project folders", async () => {
  const claudeDir = await makeDeleteDir();
  await mkdir(join(claudeDir, "projects", "-other"));
  await writeFile(join(claudeDir, "projects", "-other", `${ID1}.jsonl`), "{}\n");
  const calls: RenCall[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, renameSession: async (id, title, o) => { calls.push([id, title, o]); } });
  await assert.rejects(p.rename(ID1, "New name"), /transcripts in 2 project folders \(-other, -w\); not renaming any of them/);
  assert.equal(calls.length, 0);
});

test("rename rejects a non-UUID id and a bad title, and passes SDK errors through", async () => {
  const claudeDir = await makeDeleteDir();
  const calls: RenCall[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, renameSession: async (id, title, o) => { calls.push([id, title, o]); } });
  for (const bad of ["../x", "-rf", "b", `${ID1}x`, ""]) await assert.rejects(p.rename(bad, "New name"), /invalid Claude session id/, bad);
  await assert.rejects(p.rename(ID1, "  "), /session title is empty/);
  await assert.rejects(p.rename(ID1, "a\nb"), /single line/);
  await assert.rejects(p.rename(ID1, "x".repeat(201)), /longer than 200 characters/);
  assert.equal(calls.length, 0);
  const failing = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, renameSession: async () => { throw new Error(`Session ${ID2} not found`); } });
  await assert.rejects(failing.rename(ID2, "New name"), /not found/);
});

/** A folder to move a session to, with the project folder Claude Code keeps its sessions in. */
async function makeMoveTarget(claudeDir: string): Promise<{ cwd: string; projectDir: string }> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "claude-target-")));
  return { cwd, projectDir: join(claudeDir, "projects", claudeProjectDirName(cwd)!) };
}

test("claudeProjectDirName replaces every character but letters and digits", () => {
  assert.equal(claudeProjectDirName("/home/u/work/_my.proj"), "-home-u-work--my-proj");
  assert.equal(claudeProjectDirName("/" + "a".repeat(200)), undefined);
});

test("move takes the transcript and its directory to the target's project folder and stamps it", async () => {
  const claudeDir = await makeDeleteDir();
  const source = join(claudeDir, "projects", "-w");
  const first = jsonl({ type: "user", timestamp: new Date(T1).toISOString() });
  await mkdir(join(source, ID1, "subagents"), { recursive: true });
  await writeFile(join(source, ID1, "subagents", "agent-1.jsonl"), "{}\n");
  const { cwd, projectDir } = await makeMoveTarget(claudeDir);
  const logs: string[] = [];
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, log: (m) => logs.push(m) });
  await p.move(ID1, cwd);
  assert.deepEqual(await readdir(source), []);
  assert.equal(await readFile(join(projectDir, `${ID1}.jsonl`), "utf8"), first + jsonl({ type: "relocated", sessionId: ID1, relocatedCwd: cwd }));
  assert.equal(await readFile(join(projectDir, ID1, "subagents", "agent-1.jsonl"), "utf8"), "{}\n");
  assert.deepEqual(logs, [`claude: moved session ${ID1} to ${cwd}`]);
});

test("move completes an unterminated last line and only stamps a transcript already in place", async () => {
  const claudeDir = await makeDeleteDir();
  const { cwd, projectDir } = await makeMoveTarget(claudeDir);
  await writeFile(join(claudeDir, "projects", "-w", `${ID1}.jsonl`), '{"type":"user"}');
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel });
  await p.move(ID1, cwd);
  const stamp = jsonl({ type: "relocated", sessionId: ID1, relocatedCwd: cwd });
  assert.equal(await readFile(join(projectDir, `${ID1}.jsonl`), "utf8"), '{"type":"user"}\n' + stamp);
  await p.move(ID1, cwd);
  assert.equal(await readFile(join(projectDir, `${ID1}.jsonl`), "utf8"), '{"type":"user"}\n' + stamp + stamp);
});

test("move refuses a session with a live Claude Code process and leaves it in place", async () => {
  const claudeDir = await makeDeleteDir("idle");
  const { cwd } = await makeMoveTarget(claudeDir);
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel, isAlive: () => true });
  await assert.rejects(p.move(ID1, cwd), /open in Claude Code \(pid 700\); close it in Claude Code first/);
  assert.deepEqual(await readdir(join(claudeDir, "projects", "-w")), [`${ID1}.jsonl`]);
});

test("move refuses a bad id, a missing or duplicated transcript, a bad target and an occupied one", async () => {
  const claudeDir = await makeDeleteDir();
  const source = join(claudeDir, "projects", "-w", `${ID1}.jsonl`);
  const before = await readFile(source, "utf8");
  const { cwd, projectDir } = await makeMoveTarget(claudeDir);
  const p = new ClaudeProvider({ claudeDir, listSessions: async () => sdkDel });
  await assert.rejects(p.move("../x", cwd), /invalid Claude session id/);
  await assert.rejects(p.move(ID2, cwd), /no transcript to move/);
  await assert.rejects(p.move(ID1, "relative/dir"), /not an absolute path/);
  await assert.rejects(p.move(ID1, join(cwd, "missing")), /is not an existing folder/);
  await assert.rejects(p.move(ID1, source), /is not an existing folder/);
  // A leftover directory of the id in the target blocks the move.
  await mkdir(join(projectDir, ID1), { recursive: true });
  await assert.rejects(p.move(ID1, cwd), /already has a session with this id/);
  await writeFile(join(projectDir, `${ID1}.jsonl`), "other\n");
  await assert.rejects(p.move(ID1, cwd), /transcripts in 2 project folders .*; not moving any of them/);
  assert.equal(await readFile(source, "utf8"), before);
  assert.equal(await readFile(join(projectDir, `${ID1}.jsonl`), "utf8"), "other\n");
});
