import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionIndex } from "../codex/sessionIndex.js";
import { listRolloutFiles } from "../codex/discovery.js";
import { CodexProvider } from "../codex/provider.js";

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
