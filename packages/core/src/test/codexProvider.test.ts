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
    [meta({ id: "u1", timestamp: "2026-09-28T09:01:41.268Z", cwd: "/w", thread_source: "user" }), userMsg("первый промпт"), event("task_started"), event("task_complete")].join("\n") + "\n",
  );
  await writeFile(
    join(day, "rollout-2026-09-28T11-02-00-g1.jsonl"),
    meta({ id: "g1", thread_source: "guardian_review", parent_thread_id: "u1", cwd: "/w" }) + "\n",
  );
  await writeFile(join(day, "notes.txt"), "ignore");
  await writeFile(join(dir, "session_index.jsonl"), JSON.stringify({ id: "u1", thread_name: "Старое" }) + "\n" + JSON.stringify({ id: "u1", thread_name: "Новое имя" }) + "\n");
  return dir;
}

test("readSessionIndex keeps the last name per id", async () => {
  const dir = await makeCodexDir();
  const idx = await readSessionIndex(join(dir, "session_index.jsonl"));
  assert.equal(idx.get("u1"), "Новое имя");
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
  assert.equal(list[0].title, "Новое имя");
  assert.equal(list[0].status, "idle");
  assert.equal(list[0].cwd, "/w");
  assert.equal(list[0].createdAt, Date.parse("2026-09-28T09:01:41.268Z"));
});

test("snapshot picks up appended events and falls back to the first prompt", async () => {
  const dir = await makeCodexDir();
  await writeFile(join(dir, "session_index.jsonl"), "");
  const p = new CodexProvider({ codexDir: dir });
  assert.equal((await p.snapshot())[0].title, "первый промпт");
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

test("delete runs codex delete --force with CODEX_HOME and a 30 s timeout", async () => {
  const dir = await makeCodexDir();
  const r = recorder([]);
  const p = new CodexProvider({ codexDir: dir, env: { PATH: "/bin" }, runCommand: r.run });
  await p.snapshot();
  await p.delete("u1");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].file, "codex");
  assert.deepEqual(r.calls[0].args, ["delete", "--force", "--", "u1"]);
  assert.equal(r.calls[0].env.CODEX_HOME, dir);
  assert.equal(r.calls[0].env.PATH, "/bin");
  assert.equal(r.calls[0].timeoutMs, 30_000);
});

test("delete uses CODEX_BIN when set and does not fall back", async () => {
  const dir = await makeCodexDir();
  const ok = recorder([]);
  await new CodexProvider({ codexDir: dir, env: { CODEX_BIN: "/opt/codex" }, runCommand: ok.run }).delete("u1");
  assert.equal(ok.calls[0].file, "/opt/codex");
  const missing = recorder([enoent()]);
  await assert.rejects(new CodexProvider({ codexDir: dir, env: { CODEX_BIN: "/opt/codex" }, runCommand: missing.run }).delete("u1"), /CODEX_BIN \/opt\/codex not found/);
  assert.equal(missing.calls.length, 1);
});

test("delete retries through a login shell when codex is not on PATH", async () => {
  const dir = await makeCodexDir();
  const r = recorder([enoent(), { code: 0, stdout: "", stderr: "" }]);
  await new CodexProvider({ codexDir: dir, env: {}, runCommand: r.run }).delete("u1");
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].file, "bash");
  assert.deepEqual(r.calls[1].args, ["-lc", 'exec codex delete --force -- "$1"', "_", "u1"]);
  assert.equal(r.calls[1].env.CODEX_HOME, dir);
  const notFound = recorder([enoent(), { code: 127, stdout: "", stderr: "bash: codex: command not found" }]);
  await assert.rejects(new CodexProvider({ codexDir: dir, env: {}, runCommand: notFound.run }).delete("u1"), /not found on PATH or in a login shell/);
});

test("delete reports a non-zero exit and a timeout with the command's output", async () => {
  const dir = await makeCodexDir();
  const failed = recorder([{ code: 1, stdout: "", stderr: "Error: failed to delete session\n" }]);
  await assert.rejects(new CodexProvider({ codexDir: dir, runCommand: failed.run }).delete("u1"), /codex delete failed \(exit 1\): Error: failed to delete session$/);
  const hung = recorder([{ code: null, stdout: "", stderr: "" }]);
  await assert.rejects(new CodexProvider({ codexDir: dir, runCommand: hung.run, deleteTimeoutMs: 5000 }).delete("u1"), /timed out after 5 s/);
});

test("delete refuses a running session and an invalid id without running anything", async () => {
  const dir = await makeCodexDir();
  const file = join(dir, "sessions", "2026", "09", "28", "rollout-2026-09-28T11-01-41-u1.jsonl");
  await appendFile(file, event("task_started") + "\n");
  const r = recorder([]);
  const p = new CodexProvider({ codexDir: dir, runCommand: r.run });
  assert.equal((await p.snapshot())[0].status, "running");
  await assert.rejects(p.delete("u1"), /running/);
  await assert.rejects(p.delete("u1; rm -rf ~"), /invalid Codex session id/);
  await assert.rejects(p.delete("--help"), /invalid Codex session id/);
  assert.equal(r.calls.length, 0);
  // A session the provider has not seen is allowed: codex decides.
  await p.delete("unknown-id");
  assert.equal(r.calls.length, 1);
});
