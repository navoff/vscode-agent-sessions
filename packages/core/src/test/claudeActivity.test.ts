import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSessionFiles, lastMessageTimestamp, readLastMessageTimestamp } from "../claude/activity.js";

const T1 = "2026-09-29T10:00:00.000Z";
const T2 = "2026-09-29T10:17:49.000Z";
const T3 = "2026-09-29T12:22:00.000Z";
const rec = (o: object) => JSON.stringify(o) + "\n";
const user = (ts: string) => rec({ type: "user", timestamp: ts, message: { content: "hi" } });
const assistant = (ts: string) => rec({ type: "assistant", timestamp: ts, message: { content: "yo" } });
const bookkeeping = rec({ type: "last-prompt", lastPrompt: "hi" }) + rec({ type: "cost-state", cost: 1 });
const attachment = (n: number) => rec({ type: "attachment", timestamp: T3, blob: "x".repeat(n) });

test("lastMessageTimestamp skips trailing records without timestamps", () => {
  assert.equal(lastMessageTimestamp(user(T1) + assistant(T2) + bookkeeping), Date.parse(T2));
});

test("lastMessageTimestamp ignores non-message records with timestamps", () => {
  const text = assistant(T2) + rec({ type: "system", timestamp: T3 }) + attachment(10);
  assert.equal(lastMessageTimestamp(text), Date.parse(T2));
});

test("lastMessageTimestamp returns undefined without messages", () => {
  assert.equal(lastMessageTimestamp(bookkeeping + attachment(10)), undefined);
  assert.equal(lastMessageTimestamp(""), undefined);
});

test("lastMessageTimestamp tolerates garbage lines", () => {
  const text = user(T1) + assistant(T2) + '{"type":"assistant","timestamp":garbage\nnot json\n' + bookkeeping;
  assert.equal(lastMessageTimestamp(text), Date.parse(T2));
});

test("readLastMessageTimestamp finds a message far from the end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "act-"));
  const file = join(dir, "s.jsonl");
  const text = user(T1) + assistant(T2) + attachment(100 * 1024) + attachment(100 * 1024) + bookkeeping;
  await writeFile(file, text);
  const size = Buffer.byteLength(text);
  assert.ok(size > 64 * 1024 && size < 512 * 1024);
  assert.equal(await readLastMessageTimestamp(file, size), Date.parse(T2));
});

test("readLastMessageTimestamp handles files larger than the window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "act-"));
  const file = join(dir, "s.jsonl");
  const text = attachment(300 * 1024) + attachment(300 * 1024) + user(T1) + assistant(T2) + attachment(200 * 1024) + bookkeeping;
  await writeFile(file, text);
  const size = Buffer.byteLength(text);
  assert.ok(size > 512 * 1024);
  assert.equal(await readLastMessageTimestamp(file, size), Date.parse(T2));
});

test("indexSessionFiles maps top-level jsonl files only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "act-"));
  await mkdir(join(dir, "p1", "subagents"), { recursive: true });
  await mkdir(join(dir, "p2"));
  await writeFile(join(dir, "p1", "abc.jsonl"), "");
  await writeFile(join(dir, "p1", "subagents", "x.jsonl"), "");
  await writeFile(join(dir, "p2", "def.jsonl"), "");
  await writeFile(join(dir, "p2", "notes.txt"), "");
  const map = await indexSessionFiles(dir);
  assert.deepEqual([...map.entries()].sort(), [
    ["abc", join(dir, "p1", "abc.jsonl")],
    ["def", join(dir, "p2", "def.jsonl")],
  ]);
});

test("indexSessionFiles returns an empty map for a missing dir", async () => {
  assert.equal((await indexSessionFiles(join(tmpdir(), "no-such-dir-xyz"))).size, 0);
});
