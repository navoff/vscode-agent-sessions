import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon.mjs");

function run(args: string[], env: Record<string, string>, input?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    if (input !== undefined) child.stdin.end(input);
  });
}

test("--version prints a version", async () => {
  const r = await run(["--version"], {});
  assert.equal(r.code, 0);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+/);
});

test("stdio session answers hello and snapshot, exits on stdin close", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-"));
  await mkdir(join(home, ".claude", "sessions"), { recursive: true });
  await mkdir(join(home, ".codex", "sessions", "2026", "09", "28"), { recursive: true });
  await writeFile(
    join(home, ".codex", "sessions", "2026", "09", "28", "rollout-x-u1.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "u1", timestamp: "2026-09-28T09:00:00.000Z", cwd: "/w", thread_source: "user" } }) + "\n",
  );
  const r = await run(["--stdio"], { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") },
    '{"type":"hello","protocol":1}\n{"type":"snapshot"}\n');
  const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "hello");
  assert.equal(lines[1].type, "snapshot");
  assert.ok(lines[1].sessions.some((s: { agent: string; id: string }) => s.agent === "codex" && s.id === "u1"));
  assert.equal(r.code, 0);
});
