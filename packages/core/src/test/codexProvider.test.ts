import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionIndex } from "../codex/sessionIndex.js";
import { listRolloutFiles } from "../codex/discovery.js";
import { AppServerExitError, type AppServerRequest } from "../codex/appServer.js";
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
  assert.equal(list[0].firstPrompt, "first prompt");
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

interface ServerCall { file: string; args: string[]; method: string; params: unknown; env: NodeJS.ProcessEnv; timeoutMs: number }
function serverRecorder(results: Array<Error | undefined>) {
  const calls: ServerCall[] = [];
  const request: AppServerRequest = async (file, args, method, params, opts) => {
    calls.push({ file, args, method, params, env: opts.env, timeoutMs: opts.timeoutMs });
    const r = results.shift();
    if (r) throw r;
    return {};
  };
  return { calls, request };
}

test("rename sends thread/name/set to codex app-server with CODEX_HOME and a 30 s timeout", async () => {
  const { dir } = await makeDeleteDir();
  const s = serverRecorder([]);
  const p = new CodexProvider({ codexDir: dir, env: { PATH: "/bin" }, appServer: s.request });
  await p.rename(CID, "  New name ");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].file, "codex");
  assert.deepEqual(s.calls[0].args, ["app-server"]);
  assert.equal(s.calls[0].method, "thread/name/set");
  assert.deepEqual(s.calls[0].params, { threadId: CID, name: "New name" });
  assert.equal(s.calls[0].env.CODEX_HOME, dir);
  assert.equal(s.calls[0].env.PATH, "/bin");
  assert.equal(s.calls[0].timeoutMs, 30_000);
});

test("rename works on a running thread and on one whose writer lock is held", async () => {
  const { dir } = await makeDeleteDir("task_started");
  const lockDir = join(dir, "thread-writer-locks");
  await mkdir(lockDir, { recursive: true });
  const lock = join(lockDir, `${CID}.lock`);
  await writeFile(lock, "");
  const st = await stat(lock);
  const major = (Math.floor(st.dev / 256) & 0xfff).toString(16);
  const minor = ((st.dev & 0xff) | (Math.floor(st.dev / 4096) & 0xfff00)).toString(16);
  const locks = join(dir, "proc-locks");
  await writeFile(locks, `224: FLOCK  ADVISORY  WRITE 601322 ${major}:${minor}:${st.ino} 0 EOF\n`);
  const s = serverRecorder([]);
  const p = new CodexProvider({ codexDir: dir, appServer: s.request, procLocksPath: locks });
  assert.equal((await p.snapshot())[0].status, "running");
  await p.rename(CID, "New name");
  assert.equal(s.calls.length, 1);
});

test("rename uses CODEX_BIN when set and does not fall back", async () => {
  const { dir } = await makeDeleteDir();
  const ok = serverRecorder([]);
  await new CodexProvider({ codexDir: dir, env: { CODEX_BIN: "/opt/codex" }, appServer: ok.request }).rename(CID, "New name");
  assert.equal(ok.calls[0].file, "/opt/codex");
  const missing = serverRecorder([enoent()]);
  await assert.rejects(new CodexProvider({ codexDir: dir, env: { CODEX_BIN: "/opt/codex" }, appServer: missing.request }).rename(CID, "New name"), /CODEX_BIN \/opt\/codex not found/);
  assert.equal(missing.calls.length, 1);
});

test("rename retries through a login shell that keeps CODEX_HOME when codex is not on PATH", async () => {
  const { dir } = await makeDeleteDir();
  const s = serverRecorder([enoent()]);
  await new CodexProvider({ codexDir: dir, env: {}, appServer: s.request }).rename(CID, "New name");
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].file, "bash");
  assert.deepEqual(s.calls[1].args, ["-lc", 'CODEX_HOME="$1" exec codex app-server', "_", dir]);
  assert.deepEqual(s.calls[1].params, { threadId: CID, name: "New name" });
  const notFound = serverRecorder([enoent(), new AppServerExitError(127, "bash: codex: command not found")]);
  await assert.rejects(new CodexProvider({ codexDir: dir, env: {}, appServer: notFound.request }).rename(CID, "New name"), /not found on PATH or in a login shell/);
});

test("rename passes the server's error through and reports an early exit with its stderr", async () => {
  const { dir } = await makeDeleteDir();
  const refused = serverRecorder([new Error(`no rollout found for thread id ${CID}`)]);
  await assert.rejects(new CodexProvider({ codexDir: dir, appServer: refused.request }).rename(CID, "New name"), /^Error: no rollout found for thread id/);
  const died = serverRecorder([new AppServerExitError(1, "WARNING: something\nError: unknown subcommand app-server\n")]);
  await assert.rejects(new CodexProvider({ codexDir: dir, appServer: died.request }).rename(CID, "New name"), /codex app-server exited \(exit 1\) before answering: Error: unknown subcommand app-server$/);
});

test("rename refuses a non-UUID id and a bad title without starting anything", async () => {
  const { dir } = await makeDeleteDir();
  const s = serverRecorder([]);
  const p = new CodexProvider({ codexDir: dir, appServer: s.request });
  for (const bad of ["u1", "u1; rm -rf ~", "--help", `${CID}0`]) await assert.rejects(p.rename(bad, "New name"), /invalid Codex session id/, bad);
  await assert.rejects(p.rename(CID, " "), /session title is empty/);
  await assert.rejects(p.rename(CID, "a\nb"), /single line/);
  assert.equal(s.calls.length, 0);
});

const settingsApplied = (cwd: string) => JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "m", cwd } } });

/** An app-server that, like Codex, records the directory a thread is resumed in; `record: false` is a Codex that does not. */
function resumeRecorder(file: string, record = true) {
  const s = serverRecorder([]);
  const request: AppServerRequest = async (f, args, method, params, opts) => {
    await s.request(f, args, method, params, opts);
    if (record) await appendFile(file, settingsApplied((params as { cwd: string }).cwd) + "\n");
    return {};
  };
  return { calls: s.calls, request };
}

test("snapshot shows a thread in the directory it was last resumed in", async () => {
  const { dir, file } = await makeDeleteDir();
  const p = new CodexProvider({ codexDir: dir });
  assert.equal((await p.snapshot())[0].cwd, "/w");
  await appendFile(file, settingsApplied("/z") + "\n");
  assert.equal((await p.snapshot())[0].cwd, "/z");
});

test("move resumes the thread in the new folder through codex app-server and checks the rollout", async () => {
  const { dir, file } = await makeDeleteDir();
  const target = await mkdtemp(join(tmpdir(), "codex-target-"));
  const s = resumeRecorder(file);
  const logs: string[] = [];
  const p = new CodexProvider({ codexDir: dir, env: { PATH: "/bin" }, appServer: s.request, log: (m) => logs.push(m) });
  await p.move(CID, target);
  assert.equal(s.calls.length, 1);
  assert.deepEqual([s.calls[0].file, s.calls[0].args, s.calls[0].method], ["codex", ["app-server"], "thread/resume"]);
  assert.deepEqual(s.calls[0].params, { threadId: CID, cwd: target, excludeTurns: true });
  assert.equal(s.calls[0].env.CODEX_HOME, dir);
  assert.equal(s.calls[0].timeoutMs, 60_000);
  assert.deepEqual(logs, [`codex: moved session ${CID} to ${target}`]);
  assert.equal((await p.snapshot())[0].cwd, target);
});

test("move fails when Codex does not record the new folder", async () => {
  const { dir, file } = await makeDeleteDir();
  const target = await mkdtemp(join(tmpdir(), "codex-target-"));
  const p = new CodexProvider({ codexDir: dir, appServer: resumeRecorder(file, false).request });
  await assert.rejects(() => p.move(CID, target), /Codex did not record the new folder/);
  const failing = new CodexProvider({ codexDir: dir, appServer: serverRecorder([new Error("no rollout found for thread id")]).request });
  await assert.rejects(() => failing.move(CID, target), /no rollout found for thread id/);
});

test("move refuses a bad id or target, a running thread and one whose writer lock is held", async () => {
  const { dir, file } = await makeDeleteDir();
  const target = await mkdtemp(join(tmpdir(), "codex-target-"));
  const s = resumeRecorder(file);
  const p = new CodexProvider({ codexDir: dir, appServer: s.request });
  await assert.rejects(() => p.move("../x", target), /invalid Codex session id/);
  await assert.rejects(() => p.move(CID, "relative/dir"), /not an absolute path/);
  await assert.rejects(() => p.move(CID, join(target, "missing")), /is not an existing folder/);
  await assert.rejects(() => p.move(CID, file), /is not an existing folder/);

  const running = await makeDeleteDir("task_started");
  const busy = new CodexProvider({ codexDir: running.dir, appServer: s.request });
  await assert.rejects(() => busy.move(CID, target), /the session is running/);

  const lockDir = join(dir, "thread-writer-locks");
  await mkdir(lockDir, { recursive: true });
  const lock = join(lockDir, `${CID}.lock`);
  await writeFile(lock, "");
  const st = await stat(lock);
  const major = (Math.floor(st.dev / 256) & 0xfff).toString(16);
  const minor = ((st.dev & 0xff) | (Math.floor(st.dev / 4096) & 0xfff00)).toString(16);
  const locks = join(dir, "proc-locks");
  await writeFile(locks, `224: FLOCK  ADVISORY  WRITE 601322 ${major}:${minor}:${st.ino} 0 EOF\n`);
  const held = new CodexProvider({ codexDir: dir, appServer: s.request, procLocksPath: locks });
  await assert.rejects(() => held.move(CID, target), /open in Codex \(process 601322\)/);
  assert.equal(s.calls.length, 0);
});
