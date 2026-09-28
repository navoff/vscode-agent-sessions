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
