import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon.mjs");

function run(args: string[], env: Record<string, string>, input?: string, keepStdinOpen = false): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // With stdin kept open the daemon must exit by itself; kill it after 3 s
    // so a regression fails the test instead of hanging the runner.
    const killer = keepStdinOpen ? setTimeout(() => child.kill(), 3000) : undefined;
    child.on("close", (code) => {
      if (killer) clearTimeout(killer);
      resolve({ code, out, err });
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) {
      if (keepStdinOpen) child.stdin.write(input);
      else child.stdin.end(input);
    }
  });
}

test("--version prints the package version only", async () => {
  const r = await run(["--version"], {});
  assert.equal(r.code, 0);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+$/);
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

test("protocol mismatch answers error and exits promptly with stdin still open", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-"));
  const start = Date.now();
  const r = await run(["--stdio"], { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") },
    '{"type":"hello","protocol":99}\n{"type":"ping"}\n', true);
  const elapsed = Date.now() - start;
  const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "error");
  assert.equal(lines.length, 1);
  assert.equal(r.code, 0);
  assert.ok(elapsed < 2000, `expected prompt exit, took ${elapsed}ms`);
});

test("--listen serves a socket and exits on shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-"));
  const sock = join(home, "d.sock");
  const child = spawn(process.execPath, [bundle, "--listen", sock], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((r) => child.on("close", r));
  const { connect } = await import("node:net");
  let socket: import("node:net").Socket | undefined;
  for (let i = 0; i < 50 && !socket; i++) {
    await new Promise((r) => setTimeout(r, 100));
    socket = await new Promise((res) => { const s = connect(sock); s.once("connect", () => res(s)); s.once("error", () => res(undefined)); });
  }
  assert.ok(socket, "socket did not come up");
  const line = new Promise<string>((r) => { let buf = ""; socket!.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) r(buf.slice(0, i)); }); });
  socket.write('{"type":"hello","protocol":1}\n');
  const hello = JSON.parse(await line);
  assert.equal(hello.type, "hello");
  assert.match(hello.daemonVersion, /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
  assert.equal(await readFile(join(home, "daemon.version"), "utf8"), hello.daemonVersion);
  assert.equal(await readFile(join(home, "daemon.pid"), "utf8"), String(child.pid));
  socket.write('{"type":"shutdown"}\n');
  assert.equal(await exited, 0);
  await assert.rejects(stat(join(home, "daemon.pid")), "pid file removed");
  await assert.rejects(stat(sock), "socket removed");
});

test("--listen exits on SIGTERM and removes its socket and pid file", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-"));
  const sock = join(home, "d.sock");
  const child = spawn(process.execPath, [bundle, "--listen", sock], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((r) => child.on("close", r));
  const pidFile = join(home, "daemon.pid");
  for (let i = 0; i < 50 && !(await stat(pidFile).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await readFile(pidFile, "utf8"), String(child.pid));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  await assert.rejects(stat(pidFile));
  await assert.rejects(stat(sock));
});
