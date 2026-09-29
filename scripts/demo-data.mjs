#!/usr/bin/env node
// Generates fake Claude Code and Codex session stores for screenshots and
// manual testing. Nothing here touches the real ~/.claude or ~/.codex.
//
//   node scripts/demo-data.mjs [dir]          create <dir> (default .demo) from scratch
//   node scripts/demo-data.mjs [dir] --touch  append fresh activity so some sessions
//                                             turn unread after the tree has seen them
//
// Point the extension at it with:
//   CLAUDE_CONFIG_DIR=<dir>/claude CODEX_HOME=<dir>/codex XDG_RUNTIME_DIR=<dir>/runtime
// The "Run Extension (demo data)" launch configuration does exactly that.

import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const touch = args.includes("--touch");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? ".demo");
const claudeDir = join(dir, "claude");
const codexDir = join(dir, "codex");

const HOME = "/home/alex";
const now = Date.now();
const minutes = (n) => now - n * 60_000;
const hours = (n) => minutes(n * 60);
const days = (n) => hours(n * 24);
const iso = (ms) => new Date(ms).toISOString();
// Claude Code names project directories after the cwd with every "/" and "_" and "." turned into "-".
const projectDir = (cwd) => cwd.replace(/[/_.]/g, "-");
// Codex thread ids look like UUIDv7: time-ordered, with "7" as the version nibble.
const codexId = (ms) => {
  const hex = ms.toString(16).padStart(12, "0");
  const u = randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${u.slice(13, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
};

const CLAUDE = [
  { cwd: `${HOME}/work/shop-backend`, title: "Add rate limiting to the checkout API", prompt: "add rate limiting to the checkout endpoints", at: minutes(4), running: true },
  { cwd: `${HOME}/work/shop-backend`, title: "Investigate flaky payment tests", prompt: "why do the payment tests fail on CI?", at: hours(3) },
  { cwd: `${HOME}/work/shop-backend`, title: "Migrate orders table to UUID keys", prompt: "plan the migration of orders.id to uuid", at: days(2) },
  { cwd: `${HOME}/work/mobile-app`, title: "Dark mode for the settings screen", prompt: "implement dark mode on the settings screen", at: hours(26) },
  { cwd: `${HOME}/notes`, title: "Weekly summary draft", prompt: "summarize this week's notes", at: days(5) },
];

const CODEX = [
  { cwd: `${HOME}/work/shop-backend`, name: "Refactor cart pricing service", prompt: "refactor the cart pricing service into smaller functions", at: minutes(9), running: true },
  { cwd: `${HOME}/work/shop-backend`, name: "Fix N+1 queries in order history", prompt: "the order history page does too many queries", at: hours(5) },
  { cwd: `${HOME}/work/mobile-app`, name: "Crash on rotate in the gallery", prompt: "the gallery crashes when the phone rotates", at: days(1) },
  { cwd: `${HOME}/work/infra`, name: "Terraform module for the staging cluster", prompt: "write a terraform module for staging", at: days(8) },
];

function claudeLine(sessionId, cwd, type, ts, message) {
  return JSON.stringify({ type, uuid: randomUUID(), parentUuid: null, sessionId, cwd, timestamp: iso(ts), version: "2.1.283", message }) + "\n";
}

function writeClaude() {
  const projects = join(claudeDir, "projects");
  const registry = join(claudeDir, "sessions");
  mkdirSync(registry, { recursive: true });
  for (const s of CLAUDE) {
    const id = randomUUID();
    const pdir = join(projects, projectDir(s.cwd));
    mkdirSync(pdir, { recursive: true });
    const started = s.at - 20 * 60_000;
    let text = claudeLine(id, s.cwd, "user", started, { role: "user", content: s.prompt });
    text += claudeLine(id, s.cwd, "assistant", started + 30_000, { role: "assistant", content: [{ type: "text", text: "Let me look at the code first." }] });
    text += claudeLine(id, s.cwd, "user", s.at - 60_000, { role: "user", content: "go on" });
    text += claudeLine(id, s.cwd, "assistant", s.at, { role: "assistant", content: [{ type: "text", text: "Done. I changed three files and added tests." }] });
    text += JSON.stringify({ type: "custom-title", customTitle: s.title, sessionId: id }) + "\n";
    writeFileSync(join(pdir, `${id}.jsonl`), text);
    if (s.running) {
      // pid 1 always exists, and kill(1, 0) fails with EPERM, which the provider treats as alive.
      writeFileSync(
        join(registry, "1.json"),
        JSON.stringify({ pid: 1, sessionId: id, cwd: s.cwd, startedAt: started, entrypoint: "claude-vscode", kind: "interactive", status: "busy", updatedAt: s.at, statusUpdatedAt: s.at }),
      );
    }
  }
}

function codexEvent(ts, type, extra = {}) {
  return JSON.stringify({ timestamp: iso(ts), type: "event_msg", payload: { type, ...extra } }) + "\n";
}

function writeCodex() {
  const index = [];
  for (const s of CODEX) {
    const id = codexId(s.at - 15 * 60_000);
    const created = s.at - 15 * 60_000;
    const d = new Date(created);
    const day = join(codexDir, "sessions", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
    mkdirSync(day, { recursive: true });
    const stamp = iso(created).replace(/:/g, "-").replace(/\.\d+Z$/, "");
    let text = JSON.stringify({ timestamp: iso(created), type: "session_meta", payload: { id, timestamp: iso(created), cwd: s.cwd, originator: "codex_vscode", cli_version: "0.155.0", source: "vscode", thread_source: "user" } }) + "\n";
    text += JSON.stringify({ timestamp: iso(created + 1000), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: s.prompt }] } }) + "\n";
    text += codexEvent(created + 1500, "task_started", { turn_id: randomUUID() });
    text += JSON.stringify({ timestamp: iso(s.at - 5000), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is what I found." }] } }) + "\n";
    if (!s.running) text += codexEvent(s.at, "task_complete", { turn_id: randomUUID() });
    writeFileSync(join(day, `rollout-${stamp}-${id}.jsonl`), text);
    index.push(JSON.stringify({ id, thread_name: s.name, updated_at: iso(s.at) }));
  }
  writeFileSync(join(codexDir, "session_index.jsonl"), index.join("\n") + "\n");
}

function writeExtensionState() {
  // A remote machine that is listed but not connected, so the tree shows the machine level.
  const storage = join(dir, "user-data", "User", "globalStorage", "postnovvm.agent-sessions");
  mkdirSync(storage, { recursive: true });
  writeFileSync(
    join(storage, "machines.json"),
    JSON.stringify({ version: 1, machines: [{ id: "build-box", name: "build-box", sshHost: "build-box", enabled: true, autoConnect: false }] }, null, 2) + "\n",
  );
  const user = join(dir, "user-data", "User");
  writeFileSync(
    join(user, "settings.json"),
    JSON.stringify({ "workbench.startupEditor": "none", "workbench.colorTheme": "Default Dark Modern", "window.zoomLevel": 1, "security.workspace.trust.enabled": false, "agentSessions.showHidden": false }, null, 2) + "\n",
  );
}

function touchSessions() {
  // Newer activity on one Claude and one Codex session: they turn unread in a tree that already saw them.
  const projects = join(claudeDir, "projects");
  const pdir = join(projects, projectDir(CLAUDE[1].cwd));
  const files = readdirSync(pdir).filter((f) => f.endsWith(".jsonl")).sort();
  const target = join(pdir, files[files.length - 1]);
  const id = files[files.length - 1].replace(".jsonl", "");
  appendFileSync(target, claudeLine(id, CLAUDE[1].cwd, "assistant", now, { role: "assistant", content: [{ type: "text", text: "One more thing: the retry budget was off by one, fixed." }] }));
  const sessions = join(codexDir, "sessions");
  const rollouts = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : rollouts.push(join(d, e.name)); };
  walk(sessions);
  rollouts.sort();
  appendFileSync(rollouts[0], codexEvent(now, "task_started", { turn_id: randomUUID() }) + codexEvent(now + 1000, "task_complete", { turn_id: randomUUID() }));
  console.log("touched one Claude and one Codex session");
}

if (touch) {
  if (!existsSync(claudeDir)) {
    console.error(`${dir} does not exist yet, run without --touch first`);
    process.exit(1);
  }
  touchSessions();
} else {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeClaude();
  writeCodex();
  writeExtensionState();
  console.log(`demo data written to ${dir}`);
  console.log(`  CLAUDE_CONFIG_DIR=${claudeDir}`);
  console.log(`  CODEX_HOME=${codexDir}`);
  console.log(`  XDG_RUNTIME_DIR=${join(dir, "runtime")}`);
}
