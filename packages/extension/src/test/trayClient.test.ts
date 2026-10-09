import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeTrayMessage, TrayClient, trayBinaryPath, traySocketPath, vscodeCliPath, type TraySocket, type TrayState } from "../tray/trayClient.js";

class FakeSocket implements TraySocket {
  lines: string[] = [];
  closeCb: (() => void) | undefined;
  ended = false;
  write(line: string) { this.lines.push(line); }
  onClose(cb: () => void) { this.closeCb = cb; }
  end() { this.ended = true; }
}

interface Harness {
  client: TrayClient;
  sockets: FakeSocket[];
  spawns: number;
  log: string[];
  available: boolean;
  clock: number;
}

function harness(opts: { binary?: string | undefined; available?: boolean } = {}): Harness {
  const h: Harness = { sockets: [], spawns: 0, log: [], available: opts.available ?? true, clock: 1_000_000 } as unknown as Harness;
  h.client = new TrayClient({
    socketPath: "/tmp/t.sock",
    binaryPath: "binary" in opts ? opts.binary : "/ext/dist/tray/linux-amd64/agent-sessions-tray",
    connect: async () => {
      if (!h.available) throw new Error("ECONNREFUSED");
      const s = new FakeSocket();
      h.sockets.push(s);
      return s;
    },
    spawn: async () => {
      h.spawns++;
      h.available = true;
    },
    log: (l) => h.log.push(l),
    now: () => h.clock,
    sleep: async () => {},
  });
  return h;
}

const state: TrayState = { scheme: "vscode", sessions: [{ machine: "local", machineName: "This machine", agent: "claude", id: "a", title: "A" }] };

test("encodes one JSON object per line", () => {
  const line = encodeTrayMessage({ type: "state", ...state });
  assert.ok(line.endsWith("\n"));
  assert.equal(JSON.parse(line).sessions[0].id, "a");
});

test("connects to a running helper and sends the state", async () => {
  const h = harness();
  await h.client.setState(state);
  assert.equal(h.spawns, 0);
  assert.equal(h.client.connected, true);
  assert.deepEqual(h.sockets[0].lines, [encodeTrayMessage({ type: "state", ...state })]);
});

test("starts the helper when nothing listens, then sends the state", async () => {
  const h = harness({ available: false });
  await h.client.setState(state);
  assert.equal(h.spawns, 1);
  assert.equal(h.client.connected, true);
  assert.equal(h.sockets[0].lines.length, 1);
});

test("gives up when the helper never answers and retries a minute later", async () => {
  const h = harness({ available: false });
  h.client = new TrayClient({
    socketPath: "/tmp/t.sock",
    binaryPath: "/bin/tray",
    connect: async () => { throw new Error("ECONNREFUSED"); },
    spawn: async () => { h.spawns++; },
    log: (l) => h.log.push(l),
    now: () => h.clock,
    sleep: async () => {},
  });
  await h.client.setState(state);
  assert.equal(h.spawns, 1);
  assert.equal(h.client.connected, false);
  assert.equal(h.log.length, 1);
  await h.client.setState(state);
  assert.equal(h.spawns, 1, "no second attempt within a minute");
  h.clock += 61_000;
  await h.client.setState(state);
  assert.equal(h.spawns, 2);
  assert.equal(h.log.length, 1, "the failure is logged once");
});

test("a closed socket makes the client disconnected; notify then reports false", async () => {
  const h = harness();
  await h.client.setState(state);
  assert.equal(h.client.notify({ title: "A", body: "b", session: { machine: "local", agent: "claude", id: "a" } }), true);
  assert.equal(h.sockets[0].lines.length, 2);
  h.sockets[0].closeCb?.();
  assert.equal(h.client.connected, false);
  assert.equal(h.client.notify({ title: "A", body: "b", session: { machine: "local", agent: "claude", id: "a" } }), false);
});

test("disabling ends the socket and stops connecting", async () => {
  const h = harness();
  await h.client.setState(state);
  h.client.setEnabled(false);
  assert.equal(h.sockets[0].ended, true);
  assert.equal(h.client.connected, false);
  await h.client.setState(state);
  assert.equal(h.sockets.length, 1);
});

test("without a binary nothing is spawned or connected", async () => {
  const h = harness({ binary: undefined });
  await h.client.setState(state);
  assert.equal(h.spawns, 0);
  assert.equal(h.sockets.length, 0);
});

test("socket path lives in the private directory of the shared daemon", () => {
  assert.equal(traySocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/u"), "/run/user/1000/agent-sessions/tray.sock");
  assert.equal(traySocketPath({}, "/home/u"), "/home/u/.local/share/agent-sessions/tray.sock");
});

test("an unchanged state is not written again on the same socket", async () => {
  const h = harness();
  await h.client.setState(state);
  await h.client.setState({ ...state, sessions: [...state.sessions] });
  assert.equal(h.sockets[0].lines.length, 1);
  const changed: TrayState = { scheme: "vscode", sessions: [] };
  await h.client.setState(changed);
  assert.deepEqual(h.sockets[0].lines, [encodeTrayMessage({ type: "state", ...state }), encodeTrayMessage({ type: "state", ...changed })]);
});

test("a new socket gets the state again even when unchanged", async () => {
  const h = harness();
  await h.client.setState(state);
  h.sockets[0].closeCb?.();
  h.clock += 61_000;
  await h.client.setState(state);
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.sockets[1].lines, [encodeTrayMessage({ type: "state", ...state })]);
});

test("a summary notification carries no session", async () => {
  const h = harness();
  await h.client.setState(state);
  assert.equal(h.client.notify({ title: "4 sessions need attention", body: "" }), true);
  assert.deepEqual(JSON.parse(h.sockets[0].lines[1]), { type: "notify", title: "4 sessions need attention", body: "" });
});

test("binary path exists only for linux x64 and arm64", () => {
  assert.equal(trayBinaryPath("/ext", "linux", "x64"), "/ext/dist/tray/linux-amd64/agent-sessions-tray");
  assert.equal(trayBinaryPath("/ext", "linux", "arm64"), "/ext/dist/tray/linux-arm64/agent-sessions-tray");
  assert.equal(trayBinaryPath("/ext", "darwin", "arm64"), undefined);
  assert.equal(trayBinaryPath("/ext", "linux", "ia32"), undefined);
});

test("dispose during a connect attempt ends the late socket and sends nothing", async () => {
  const late = new FakeSocket();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const client = new TrayClient({
    socketPath: "/tmp/t.sock",
    binaryPath: "/bin/tray",
    connect: async () => { await gate; return late; },
    spawn: async () => {},
    log: () => {},
    sleep: async () => {},
  });
  const pending = client.setState(state);
  client.dispose();
  release();
  await pending;
  assert.equal(client.connected, false);
  assert.equal(late.ended, true);
  assert.deepEqual(late.lines, []);
});

test("turning the tray back on retries without waiting for the rate limit", async () => {
  const h = harness({ available: false });
  let spawns = 0;
  h.client = new TrayClient({
    socketPath: "/tmp/t.sock",
    binaryPath: "/bin/tray",
    connect: async () => { throw new Error("ECONNREFUSED"); },
    spawn: async () => { spawns++; },
    log: () => {},
    now: () => h.clock,
    sleep: async () => {},
  });
  await h.client.setState(state);
  assert.equal(spawns, 1);
  h.client.setEnabled(false);
  h.client.setEnabled(true);
  await h.client.setState(state);
  assert.equal(spawns, 2);
});

test("vscodeCliPath finds the CLI next to the app root", () => {
  const root = "/usr/share/code/resources/app";
  assert.equal(vscodeCliPath(root, "vscode", () => true), "/usr/share/code/bin/code");
  assert.equal(vscodeCliPath(root, "vscode", () => false), undefined);
  assert.equal(vscodeCliPath("/opt/vscodium/resources/app", "vscodium", () => true), "/opt/vscodium/bin/codium");
  assert.equal(vscodeCliPath(root, "cursor", () => true), undefined);
});
