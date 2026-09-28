import { test } from "node:test";
import assert from "node:assert/strict";
import { isNodeVersionSupported, prepareMachine, resolvePlatform, type SshRunner } from "../machines/prepare.js";

type Reply = { code?: number; stdout?: string; stderr?: string };
function fakeSsh(replies: Array<[RegExp, Reply]>) {
  const calls: Array<{ command: string; stdin?: string }> = [];
  const ssh: SshRunner = {
    async run(_host, command, stdin) {
      calls.push({ command, stdin });
      const hit = replies.find(([re]) => re.test(command));
      const r = hit?.[1] ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
  return { ssh, calls };
}

test("resolvePlatform maps uname output", () => {
  assert.deepEqual(resolvePlatform("Linux x86_64\n"), { os: "linux", arch: "x64" });
  assert.deepEqual(resolvePlatform("Linux aarch64"), { os: "linux", arch: "arm64" });
  assert.deepEqual(resolvePlatform("Darwin arm64"), { os: "darwin", arch: "arm64" });
  assert.equal(resolvePlatform("MINGW64_NT x86_64"), undefined);
  assert.ok(isNodeVersionSupported("22.15.0"));
  assert.ok(!isNodeVersionSupported("v18.20.1"));
});

test("uses existing node and copies daemon via stdin", async () => {
  const { ssh, calls } = fakeSsh([
    [/uname/, { stdout: "Linux x86_64" }],
    [/echo \$HOME/, { stdout: "/home/navoff\n" }],
    [/agent-sessions\/node\/bin\/node'? -p/, { code: 1 }],
    [/command -v node/, { stdout: "/usr/bin/node\n" }],
    [/'?\/usr\/bin\/node'? -p process\.versions\.node/, { stdout: "22.1.0\n" }],
    [/daemon\.mjs'? --version/, { stdout: "0.1.0\n" }],
  ]);
  const steps: string[] = [];
  const r = await prepareMachine("hz", ssh, "DAEMON SOURCE", (s) => steps.push(s));
  assert.deepEqual(r, { remoteNode: "/usr/bin/node", daemonVersion: "0.1.0", remoteHome: "/home/navoff" });
  const copy = calls.find((c) => c.stdin === "DAEMON SOURCE");
  assert.ok(copy && copy.command.includes("/home/navoff/.local/share/agent-sessions/daemon.mjs"));
  assert.ok(!calls.some((c) => c.command.includes("nodejs.org")));
  assert.ok(steps.length >= 4);
});

test("downloads node when none is usable", async () => {
  const { ssh, calls } = fakeSsh([
    [/uname/, { stdout: "Linux aarch64" }],
    [/echo \$HOME/, { stdout: "/root" }],
    [/agent-sessions\/node\/bin\/node'? -p/, { code: 127 }],
    [/command -v node/, { stdout: "/usr/bin/node" }],
    [/\/usr\/bin\/node -p/, { stdout: "v18.0.0" }],
    [/nodejs\.org/, { code: 0 }],
    [/daemon\.mjs'? --version/, { stdout: "0.1.0" }],
  ]);
  const r = await prepareMachine("hz", ssh, "src", () => {});
  assert.equal(r.remoteNode, "/root/.local/share/agent-sessions/node/bin/node");
  const dl = calls.find((c) => c.command.includes("nodejs.org"))!;
  assert.ok(dl.command.includes("node-v22.15.0-linux-arm64.tar.gz"));
});

test("fails with a step name when ssh fails", async () => {
  const { ssh } = fakeSsh([[/uname/, { code: 255, stderr: "Permission denied" }]]);
  await assert.rejects(() => prepareMachine("hz", ssh, "src", () => {}), /Checking platform.*Permission denied/s);
});

test("quotes remote paths that contain spaces", async () => {
  const { ssh, calls } = fakeSsh([
    [/uname/, { stdout: "Linux x86_64" }],
    [/echo \$HOME/, { stdout: "/Users/John Doe" }],
    [/agent-sessions\/node\/bin\/node'? -p/, { stdout: "22.1.0" }],
    [/daemon\.mjs'? --version/, { stdout: "0.1.0" }],
  ]);
  const r = await prepareMachine("hz", ssh, "src", () => {});
  assert.equal(r.remoteNode, "/Users/John Doe/.local/share/agent-sessions/node/bin/node");
  const probe = calls.find((c) => c.command.includes("process.versions.node"));
  assert.ok(probe && probe.command.includes("'/Users/John Doe/.local/share/agent-sessions/node/bin/node' -p"));
  const copy = calls.find((c) => c.stdin === "src");
  assert.ok(copy && copy.command.includes("cat > '/Users/John Doe/.local/share/agent-sessions/daemon.mjs'"));
  const verify = calls.find((c) => c.command.includes("--version"));
  assert.ok(verify && verify.command.includes("'/Users/John Doe/.local/share/agent-sessions/daemon.mjs' --version"));
});
