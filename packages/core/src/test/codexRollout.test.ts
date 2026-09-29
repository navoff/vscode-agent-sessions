import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFirstPrompt, parseRolloutMeta, readRolloutInfo, statusFromTail, titleFromUserText } from "../codex/rollout.js";

const meta = (payload: Record<string, unknown>) => JSON.stringify({ type: "session_meta", payload });
const userMsg = (text: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const event = (type: string) => JSON.stringify({ type: "event_msg", payload: { type } });

test("parseRolloutMeta recognises user, guardian and legacy threads", () => {
  const user = parseRolloutMeta(meta({ id: "u1", timestamp: "2026-09-28T09:01:41.268Z", cwd: "/w", source: "vscode", thread_source: "user" }));
  assert.deepEqual(user, { id: "u1", cwd: "/w", createdAt: Date.parse("2026-09-28T09:01:41.268Z"), isUserThread: true });
  const guardian = parseRolloutMeta(meta({ id: "g1", parent_thread_id: "u1", cwd: "/w", source: { subagent: { other: "guardian" } }, thread_source: "guardian_review" }));
  assert.equal(guardian?.isUserThread, false);
  const legacy = parseRolloutMeta(meta({ id: "l1", timestamp: "2026-08-07T17:42:41.000Z", cwd: "/w", source: "cli" }));
  assert.equal(legacy?.isUserThread, true);
  assert.equal(parseRolloutMeta("{}"), undefined);
  assert.equal(parseRolloutMeta("garbage"), undefined);
  const userWithParent = parseRolloutMeta(meta({ id: "c1", thread_source: "user", parent_thread_id: "u1", cwd: "/w" }));
  assert.equal(userWithParent?.isUserThread, false);
  const userWithSource = parseRolloutMeta(meta({ id: "c2", thread_source: "user", source: { subagent: { other: "guardian" } } }));
  assert.equal(userWithSource?.isUserThread, false);
});

test("titleFromUserText skips system blocks and trims to first line", () => {
  assert.equal(titleFromUserText("<environment_context>\n..."), undefined);
  assert.equal(titleFromUserText("# AGENTS.md instructions"), undefined);
  assert.equal(titleFromUserText("   \n"), undefined);
  assert.equal(titleFromUserText("почему PR требует ship\nвторая строка"), "почему PR требует ship");
  assert.equal(titleFromUserText("x".repeat(100))?.length, 80);
});

test("extractFirstPrompt returns the first real user text", () => {
  const lines = [meta({ id: "u1" }), userMsg("<recommended_plugins>\n"), userMsg("# AGENTS.md instructions"), userMsg("сделай отчёт"), userMsg("второе")];
  assert.equal(extractFirstPrompt(lines), "сделай отчёт");
  assert.equal(extractFirstPrompt([meta({ id: "u1" })]), undefined);
});

test("statusFromTail follows the last task event", () => {
  assert.equal(statusFromTail([event("task_started"), event("token_count")].join("\n")), "running");
  assert.equal(statusFromTail([event("task_started"), event("task_complete")].join("\n")), "idle");
  assert.equal(statusFromTail([event("task_started"), event("turn_aborted")].join("\n")), "idle");
  assert.equal(statusFromTail(""), "idle");
});

test("statusFromTail ignores task events quoted inside messages", () => {
  const msgWithQuotedEvent = userMsg('The error message was "type":"task_started"');
  const tail = [msgWithQuotedEvent, event("task_complete")].join("\n");
  assert.equal(statusFromTail(tail), "idle");
  assert.equal(statusFromTail(msgWithQuotedEvent), "idle");
});

test("readRolloutInfo reads meta, title and status from a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-"));
  const file = join(dir, "rollout-2026-09-28T11-01-41-u1.jsonl");
  const lines = [
    meta({ id: "u1", timestamp: "2026-09-28T09:01:41.268Z", cwd: "/w", source: "vscode", thread_source: "user" }),
    userMsg("<environment_context>"),
    userMsg("задача дня"),
    event("task_started"),
  ];
  await writeFile(file, lines.join("\n") + "\n");
  const info = await readRolloutInfo(file, (await stat(file)).size);
  assert.equal(info?.meta.id, "u1");
  assert.equal(info?.title, "задача дня");
  assert.equal(info?.status, "running");
});

test("readRolloutInfo skips title and tail for service threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-"));
  const file = join(dir, "rollout-g.jsonl");
  await writeFile(file, meta({ id: "g1", thread_source: "guardian_review", parent_thread_id: "u1" }) + "\n" + userMsg("hidden") + "\n");
  const info = await readRolloutInfo(file, (await stat(file)).size);
  assert.equal(info?.meta.isUserThread, false);
  assert.equal(info?.title, undefined);
});

const filler = () => JSON.stringify({ type: "response_item", payload: { type: "reasoning", text: "x".repeat(600) } });

async function writeRollout(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-"));
  const file = join(dir, "rollout-long.jsonl");
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

test("readRolloutInfo finds task_started more than 64 KB before the end", async () => {
  const head = [meta({ id: "u1", cwd: "/w", thread_source: "user" }), userMsg("long turn"), event("task_complete"), event("task_started")];
  const file = await writeRollout([...head, ...Array.from({ length: 200 }, filler)]);
  const size = (await stat(file)).size;
  assert.ok(size > 128 * 1024);
  const info = await readRolloutInfo(file, size);
  assert.equal(info?.status, "running");
});

test("readRolloutInfo sees task_complete that follows a long turn", async () => {
  const head = [meta({ id: "u1", cwd: "/w", thread_source: "user" }), userMsg("long turn"), event("task_started")];
  const file = await writeRollout([...head, ...Array.from({ length: 200 }, filler), event("task_complete"), ...Array.from({ length: 200 }, filler)]);
  const info = await readRolloutInfo(file, (await stat(file)).size);
  assert.equal(info?.status, "idle");
});

const stamped = (type: string, timestamp: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp, type: "event_msg", payload: { type, ...payload } });
const stampedUser = (text: string, timestamp: string) =>
  JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

test("readRolloutInfo takes activity time from messages and task events, not bookkeeping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-"));
  const file = join(dir, "rollout-act.jsonl");
  const lines = [
    meta({ id: "u1", timestamp: "2026-09-08T14:00:00.000Z", cwd: "/w", thread_source: "user" }),
    stampedUser("вопрос", "2026-09-08T14:59:31.546Z"),
    stamped("task_started", "2026-09-08T14:59:31.600Z"),
    stamped("task_complete", "2026-09-08T14:59:40.000Z"),
    stamped("thread_settings_applied", "2026-09-29T10:37:44.229Z"),
    stamped("token_count", "2026-09-29T10:37:45.000Z"),
  ];
  await writeFile(file, lines.join("\n") + "\n");
  const info = await readRolloutInfo(file, (await stat(file)).size);
  assert.equal(info?.status, "idle");
  assert.equal(info?.activityAt, Date.parse("2026-09-08T14:59:40.000Z"));
});

test("readRolloutInfo finds the activity time beyond 64 KB of bookkeeping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-"));
  const file = join(dir, "rollout-far.jsonl");
  const filler = Array.from({ length: 300 }, () => stamped("token_count", "2026-09-29T10:00:00.000Z", { pad: "x".repeat(400) }));
  const lines = [
    meta({ id: "u2", thread_source: "user", cwd: "/w" }),
    stampedUser("вопрос", "2026-09-08T14:59:31.546Z"),
    stamped("task_started", "2026-09-08T14:59:32.000Z"),
    ...filler,
  ];
  await writeFile(file, lines.join("\n") + "\n");
  const size = (await stat(file)).size;
  assert.ok(size > 64 * 1024);
  const info = await readRolloutInfo(file, size);
  assert.equal(info?.status, "running");
  assert.equal(info?.activityAt, Date.parse("2026-09-08T14:59:32.000Z"));
});

test("readRolloutInfo leaves activityAt undefined without timestamps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-"));
  const file = join(dir, "rollout-nots.jsonl");
  await writeFile(file, [meta({ id: "u3", thread_source: "user", cwd: "/w" }), userMsg("x"), event("task_complete")].join("\n") + "\n");
  const info = await readRolloutInfo(file, (await stat(file)).size);
  assert.equal(info?.activityAt, undefined);
});
