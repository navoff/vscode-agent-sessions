import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionIndex } from "../codex/sessionIndex.js";
import { listRolloutFiles } from "../codex/discovery.js";
import { CodexProvider, type CommandResult, type CommandRunner } from "../codex/provider.js";

const meta = (payload: Record<string, unknown>) => JSON.stringify({ type: "session_meta", payload });
const userMsg = (text: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const event = (type: string) => JSON.stringify({ type: "event_msg", payload: { type } });

async function makeCodexDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-home-"));
  const day = join(dir, "sessions", "2026", "09", "28");
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, "rollout-2026-09-28T11-01-41-u1.jsonl"),
    [meta({ id: "u1", timestamp: "2026-09-28T09:01:41.268Z", cwd: "/w", thread_source: "user" }), userMsg("first prompt"), event("task_started"), event("task_complete")].join("\n") + "\n",
  );
  await writeFile(
    join(day, "rollout-2026-09-28T11-02-00-g1.jsonl"),
    meta({ id: "g1", thread_source: "guardian_review", parent_thread_id: "u1", cwd: "/w" }) + "\n",
  );
  await writeFile(join(day, "notes.txt"), "ignore");
  await writeFile(join(dir, "session_index.jsonl"), JSON.stringify({ id: "u1", thread_name: "Old name" }) + "\n" + JSON.stringify({ id: "u1", thread_name: "New name" }) + "\n");
  return dir;
}

test("readSessionIndex keeps the last name per id", async () => {
  const dir = await makeCodexDir();
  const idx = await readSessionIndex(join(dir, "session_index.jsonl"));
  assert.equal(idx.get("u1"), "New name");
  assert.equal((await readSessionIndex("/nope/index.jsonl")).size, 0);
});

test("listRolloutFiles finds rollout files recursively", async () => {
  const dir = await makeCodexDir();
  const files = await listRolloutFiles(join(dir, "sessions"));
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => f.endsWith(".jsonl")));
});

test("snapshot returns user threads with index titles and statuses", async () => {
  const dir = await makeCodexDir();
  const p = new CodexProvider({ codexDir: dir });
  const list = await p.snapshot();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "u1");
  assert.equal(list[0].title, "New name");
  assert.equal(list[0].status, "idle");
  assert.equal(list[0].cwd, "/w");
  assert.equal(list[0].createdAt, Date.parse("2026-09-28T09:01:41.268Z"));
});

test("snapshot picks up appended events and falls back to the first prompt", async () => {
  const dir = await makeCodexDir();
  await writeFile(join(dir, "session_index.jsonl"), "");
  const p = new CodexProvider({ codexDir: dir });
  assert.equal((await p.snapshot())[0].title, "first prompt");
  const file = join(dir, "sessions", "2026", "09", "28", "rollout-2026-09-28T11-01-41-u1.jsonl");
  await new Promise((r) => setTimeout(r, 20));
  await appendFile(file, event("task_started") + "\n");
  assert.equal((await p.snapshot())[0].status, "running");
});

async function makeDuplicateIdDir(): Promise<{ dir: string; newerFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "codex-dup-"));
  const day27 = join(dir, "sessions", "2026", "09", "27");
  const day28 = join(dir, "sessions", "2026", "09", "28");
  await mkdir(day27, { recursive: true });
  await mkdir(day28, { recursive: true });
  const olderFile = join(day27, "rollout-2026-09-27T10-00-00-d1.jsonl");
  const newerFile = join(day28, "rollout-2026-09-28T10-00-00-d1.jsonl");
  await writeFile(
    olderFile,
    [meta({ id: "d1", timestamp: "2026-09-27T10:00:00.000Z", cwd: "/w", thread_source: "user" }), userMsg("older prompt")].join("\n") + "\n",
  );
  await writeFile(
    newerFile,
    [meta({ id: "d1", timestamp: "2026-09-28T10:00:00.000Z", cwd: "/w", thread_source: "user" }), userMsg("newer prompt")].join("\n") + "\n",
  );
  const olderTime = new Date("2026-09-27T10:00:00.000Z");
  const newerTime = new Date("2026-09-28T11:00:00.000Z");
  await utimes(olderFile, olderTime, olderTime);
  await utimes(newerFile, newerTime, newerTime);
  return { dir, newerFile };
}

test("snapshot keeps the newest file when two rollouts share an id", async () => {
  const { dir, newerFile } = await makeDuplicateIdDir();
  const newerStat = await stat(newerFile);
  const p = new CodexProvider({ codexDir: dir });
  const list = await p.snapshot();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "d1");
  assert.equal(list[0].updatedAt, Math.trunc(newerStat.mtimeMs));
});

interface Call { file: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }
function recorder(results: Array<CommandResult | NodeJS.ErrnoException>) {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, opts) => {
    calls.push({ file, args, env: opts.env, timeoutMs: opts.timeoutMs });
    const r = results.shift() ?? { code: 0, stdout: "", stderr: "" };
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, run };
}
const enoent = () => Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
const CID = "0199a1b2-c3d4-7e5f-8a9b-0123456789ab";

/** A Codex dir with one user thread CID whose rollout ends with `last`. */
async function makeDeleteDir(last: "task_started" | "task_complete" = "task_complete"): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "codex-del-"));
  const day = join(dir, "sessions", "2026", "09", "29");
  await mkdir(day, { recursive: true });
  const file = join(day, `rollout-2026-09-29T10-00-00-${CID}.jsonl`);
  await writeFile(file, [meta({ id: CID, timestamp: "2026-09-29T10:00:00.000Z", cwd: "/w", thread_source: "user" }), userMsg("hi"), event("task_started"), event(last)].join("\n") + "\n");
  return { dir, file };
}

test("delete runs codex delete --force with CODEX_HOME and a 30 s timeout", async () => {
  const { dir } = await makeDeleteDir();
  const r = recorder([]);
  const p = new CodexProvider({ codexDir: dir, env: { PATH: "/bin" }, runCommand: r.run });
  await p.snapshot();
  await p.delete(CID);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].file, "codex");
  assert.deepEqual(r.calls[0].args, ["delete", "--force", "--", CID]);
  assert.equal(r.calls[0].env.CODEX_HOME, dir);
  assert.equal(r.calls[0].env.PATH, "/bin");
  assert.equal(r.calls[0].timeoutMs, 30_000);
});

test("delete uses CODEX_BIN when set and does not fall back", async () => {
  const { dir } = await makeDeleteDir();
  const ok = recorder([]);
  await new CodexProvider({ codexDir: dir, env: { CODEX_BIN: "/opt/codex" }, runCommand: ok.run }).delete(CID);
  assert.equal(ok.calls[0].file, "/opt/codex");
  const missing = recorder([enoent()]);
  await assert.rejects(new CodexProvider({ codexDir: dir, env: { CODEX_BIN: "/opt/codex" }, runCommand: missing.run }).delete(CID), /CODEX_BIN \/opt\/codex not found/);
  assert.equal(missing.calls.length, 1);
});

test("delete retries through a login shell that keeps CODEX_HOME when codex is not on PATH", async () => {
  const { dir } = await makeDeleteDir();
  const r = recorder([enoent(), { code: 0, stdout: "", stderr: "" }]);
  await new CodexProvider({ codexDir: dir, env: {}, runCommand: r.run }).delete(CID);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].file, "bash");
  assert.deepEqual(r.calls[1].args, ["-lc", 'CODEX_HOME="$2" exec codex delete --force -- "$1"', "_", CID, dir]);
  const notFound = recorder([enoent(), { code: 127, stdout: "", stderr: "bash: codex: command not found" }]);
  await assert.rejects(new CodexProvider({ codexDir: dir, env: {}, runCommand: notFound.run }).delete(CID), /not found on PATH or in a login shell/);
});

test("delete reports a non-zero exit, preferring Error lines, and a timeout", async () => {
  const { dir } = await makeDeleteDir();
  const failed = recorder([{ code: 1, stdout: "", stderr: "WARNING: proceeding, even though we could not create PATH aliases\nError: failed to delete session\n" }]);
  await assert.rejects(new CodexProvider({ codexDir: dir, runCommand: failed.run }).delete(CID), /codex delete failed \(exit 1\): Error: failed to delete session$/);
  const plain = recorder([{ code: 2, stdout: "", stderr: "something odd\n" }]);
  await assert.rejects(new CodexProvider({ codexDir: dir, runCommand: plain.run }).delete(CID), /\(exit 2\): something odd$/);
  const hung = recorder([{ code: null, stdout: "", stderr: "" }]);
  await assert.rejects(new CodexProvider({ codexDir: dir, runCommand: hung.run, deleteTimeoutMs: 5000 }).delete(CID), /timed out after 5 s/);
});

test("delete reads the rollout now: a stale idle snapshot does not hide a started task", async () => {
  const { dir, file } = await makeDeleteDir();
  const r = recorder([]);
  const p = new CodexProvider({ codexDir: dir, runCommand: r.run });
  assert.equal((await p.snapshot())[0].status, "idle");
  await appendFile(file, event("task_started") + "\n");
  await assert.rejects(p.delete(CID), /running/);
  // Before any snapshot the rollout is found by its file name.
  await assert.rejects(new CodexProvider({ codexDir: dir, runCommand: r.run }).delete(CID), /running/);
  assert.equal(r.calls.length, 0);
});

test("delete refuses a non-UUID id without running anything and allows an unknown session", async () => {
  const { dir } = await makeDeleteDir("task_started");
  const r = recorder([]);
  const p = new CodexProvider({ codexDir: dir, runCommand: r.run });
  for (const bad of ["u1", "u1; rm -rf ~", "--help", `${CID}0`]) await assert.rejects(p.delete(bad), /invalid Codex session id/, bad);
  assert.equal(r.calls.length, 0);
  // No rollout for this id: codex decides.
  await p.delete("00000000-0000-4000-8000-000000000000");
  assert.equal(r.calls.length, 1);
});

test("delete refuses a thread whose writer lock is held and names the process", async () => {
  const { dir } = await makeDeleteDir();
  const lockDir = join(dir, "thread-writer-locks");
  await mkdir(lockDir, { recursive: true });
  const lock = join(lockDir, `${CID}.lock`);
  await writeFile(lock, "");
  const st = await stat(lock);
  const major = (Math.floor(st.dev / 256) & 0xfff).toString(16);
  const minor = ((st.dev & 0xff) | (Math.floor(st.dev / 4096) & 0xfff00)).toString(16);
  const locks = join(dir, "proc-locks");
  await writeFile(locks, `224: FLOCK  ADVISORY  WRITE 601322 ${major}:${minor}:${st.ino} 0 EOF\n`);
  const r = recorder([]);
  const p = new CodexProvider({ codexDir: dir, runCommand: r.run, procLocksPath: locks });
  await p.snapshot();
  await assert.rejects(() => p.delete(CID), /open in Codex \(process 601322\).*Close it in Codex/);
  assert.equal(r.calls.length, 0);
  // An unheld lock file does not block deletion.
  await writeFile(locks, "");
  await p.delete(CID);
  assert.equal(r.calls.length, 1);
});

test("snapshot uses the last activity time instead of the file mtime", async () => {
  const dir = await makeCodexDir();
  const day = join(dir, "sessions", "2026", "09", "28");
  const stampedEvent = (type: string, timestamp: string) => JSON.stringify({ timestamp, type: "event_msg", payload: { type } });
  await writeFile(
    join(day, "rollout-2026-09-08T16-59-19-old1.jsonl"),
    [
      meta({ id: "old1", timestamp: "2026-09-08T14:00:00.000Z", cwd: "/w", thread_source: "user" }),
      userMsg("old question"),
      stampedEvent("task_started", "2026-09-08T14:59:31.600Z"),
      stampedEvent("task_complete", "2026-09-08T14:59:40.000Z"),
      stampedEvent("thread_settings_applied", "2026-09-29T10:37:44.229Z"),
    ].join("\n") + "\n",
  );
  const p = new CodexProvider({ codexDir: dir });
  const old = (await p.snapshot()).find((s) => s.id === "old1");
  assert.equal(old?.updatedAt, Date.parse("2026-09-08T14:59:40.000Z"));
});
