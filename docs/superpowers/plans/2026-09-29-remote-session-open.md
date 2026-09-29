# Remote Session Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-clicking a remote session opens a Remote-SSH window on its folder and opens the session there.

**Architecture:** The extension asks the session's daemon (protocol 3, `pendingOpen`) to write `~/.local/share/agent-sessions/pending-open.json` on that machine, then opens `vscode-remote://ssh-remote+<host><cwd>` in a new window. The extension in that window reads the file on activation or focus, checks freshness and folder, and opens the session as local. The local "Open Folder in New Window" flow uses the same file instead of `globalState`.

**Tech Stack:** TypeScript, Node 22 test runner (`node --test`), VS Code extension API, npm workspaces (`core`, `daemon`, `extension`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-29-remote-session-open-design.md`.
- Pending file path is fixed under home: `~/.local/share/agent-sessions/pending-open.json` (not `XDG_RUNTIME_DIR`).
- Pending entry TTL stays `PENDING_OPEN_TTL_MS = 2 * 60_000`.
- Quotes `"` and dashes `-` in prose; English strings in code, tests and docs.
- One commit per task; run `npm test` in the touched package before each commit.

---

### Task 1: Pending-open file helpers in the daemon package

**Files:**
- Create: `packages/daemon/src/pendingOpen.ts`
- Modify: `packages/daemon/src/index.ts` (export)
- Test: `packages/daemon/src/test/pendingOpen.test.ts`

**Interfaces:**
- Produces:
  - `interface PendingOpen { session: SessionInfo; at: number }`
  - `pendingOpenPath(home: string): string`
  - `writePendingOpen(home: string, session: SessionInfo, now: number): Promise<void>` - rejects with `Error("<cwd> does not exist")` when `session.cwd` is not a directory.
  - `readPendingOpen(home: string): Promise<PendingOpen | undefined>` - `undefined` on missing file or broken content.
  - `clearPendingOpen(home: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@agent-sessions/core";
import { clearPendingOpen, pendingOpenPath, readPendingOpen, writePendingOpen } from "../pendingOpen.js";

const session = (cwd: string): SessionInfo => ({ agent: "claude", id: "a", title: "a", cwd, createdAt: 1, updatedAt: 1, status: "idle" });

test("pendingOpenPath is fixed under home", () => {
  assert.equal(pendingOpenPath("/h"), "/h/.local/share/agent-sessions/pending-open.json");
});

test("write, read and clear a pending open", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-pending-"));
  await writePendingOpen(home, session(home), 1000);
  assert.deepEqual(await readPendingOpen(home), { session: session(home), at: 1000 });
  assert.match(await readFile(pendingOpenPath(home), "utf8"), /"at":1000/);
  await clearPendingOpen(home);
  assert.equal(await readPendingOpen(home), undefined);
  await clearPendingOpen(home); // missing file is fine
});

test("writing refuses a session whose folder is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-pending-"));
  await assert.rejects(writePendingOpen(home, session(join(home, "gone")), 1), /does not exist/);
  assert.equal(await readPendingOpen(home), undefined);
});

test("reading tolerates broken content", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-pending-"));
  await writePendingOpen(home, session(home), 1);
  await writeFile(pendingOpenPath(home), "{not json");
  assert.equal(await readPendingOpen(home), undefined);
  await writeFile(pendingOpenPath(home), JSON.stringify({ session: { id: 1 }, at: "x" }));
  assert.equal(await readPendingOpen(home), undefined);
});
```

- [ ] **Step 2: Run it** - `cd packages/daemon && npm test` - expect a compile error: module `../pendingOpen.js` not found.

- [ ] **Step 3: Implement**

```ts
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionInfo } from "@agent-sessions/core";
import { isSessionInfo } from "./protocol.js";

/**
 * A session that a window on its folder should open. Written on the
 * machine that holds the session, by its daemon, and read by the extension
 * of a window that opens on that machine.
 */
export interface PendingOpen {
  session: SessionInfo;
  at: number;
}

/** Fixed under home: the ssh daemon runs without XDG_RUNTIME_DIR, the extension host may have it. */
export function pendingOpenPath(home: string): string {
  return join(home, ".local", "share", "agent-sessions", "pending-open.json");
}

export async function writePendingOpen(home: string, session: SessionInfo, now: number): Promise<void> {
  const st = await stat(session.cwd).catch(() => undefined);
  if (!st?.isDirectory()) throw new Error(`${session.cwd} does not exist`);
  const path = pendingOpenPath(home);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const entry: PendingOpen = { session, at: now };
  await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
  await rename(tmp, path);
}

export async function readPendingOpen(home: string): Promise<PendingOpen | undefined> {
  const text = await readFile(pendingOpenPath(home), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isSessionInfo(r.session) || typeof r.at !== "number") return undefined;
  return { session: r.session, at: r.at };
}

export async function clearPendingOpen(home: string): Promise<void> {
  await rm(pendingOpenPath(home), { force: true });
}
```

Export `isSessionInfo` from `protocol.ts` (drop the `function` keyword's privacy: `export function isSessionInfo`). Add to `packages/daemon/src/index.ts`:

```ts
export { clearPendingOpen, pendingOpenPath, readPendingOpen, writePendingOpen, type PendingOpen } from "./pendingOpen.js";
```

- [ ] **Step 4: Run** `npm test` in `packages/daemon` - all pass.

- [ ] **Step 5: Commit** `daemon: Add the pending-open file helpers`

---

### Task 2: Protocol 3 with pendingOpen / pendingOpenResult

**Files:**
- Modify: `packages/daemon/src/protocol.ts`
- Test: `packages/daemon/src/test/daemon.test.ts` (next to "parse delete and deleteResult messages")

**Interfaces:**
- Produces:
  - `PROTOCOL_VERSION = 3`
  - `ClientMessage` gains `{ type: "pendingOpen"; requestId: string; session: SessionInfo }`
  - `DaemonMessage` gains `{ type: "pendingOpenResult"; requestId: string; ok: boolean; error?: string }`

- [ ] **Step 1: Write the failing test**

```ts
test("parse pendingOpen and pendingOpenResult messages", () => {
  const good = s("claude", "a");
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "pendingOpen", requestId: "9", session: good })), { type: "pendingOpen", requestId: "9", session: good });
  assert.equal(parseClientMessage(JSON.stringify({ type: "pendingOpen", session: good })), undefined);
  assert.equal(parseClientMessage(JSON.stringify({ type: "pendingOpen", requestId: "9", session: { id: "a" } })), undefined);
  assert.deepEqual(parseDaemonMessage('{"type":"pendingOpenResult","requestId":"9","ok":true}'), { type: "pendingOpenResult", requestId: "9", ok: true });
  assert.deepEqual(parseDaemonMessage('{"type":"pendingOpenResult","requestId":"9","ok":false,"error":"no"}'), { type: "pendingOpenResult", requestId: "9", ok: false, error: "no" });
  assert.equal(parseDaemonMessage('{"type":"pendingOpenResult","ok":true}'), undefined);
});
```

- [ ] **Step 2: Run** - fails: parse returns `undefined` for both.

- [ ] **Step 3: Implement** in `protocol.ts`: comment `/** 3 added "pendingOpen" and "pendingOpenResult". */`, `PROTOCOL_VERSION = 3`, union members, and in the switches:

```ts
    case "pendingOpen":
      return typeof r.requestId === "string" && isSessionInfo(r.session)
        ? { type: "pendingOpen", requestId: r.requestId, session: r.session }
        : undefined;
```

```ts
    case "pendingOpenResult": {
      if (typeof r.requestId !== "string" || typeof r.ok !== "boolean") return undefined;
      const msg: DaemonMessage = { type: "pendingOpenResult", requestId: r.requestId, ok: r.ok };
      if (typeof r.error === "string") msg.error = r.error;
      return msg;
    }
```

`isSessionInfo` is declared after `parseClientMessage`; function declarations hoist, so no move is needed.

- [ ] **Step 4: Run** `npm test` in `packages/daemon` and `packages/extension` (the extension switches over `DaemonMessage` in `lineClient.ts`; a missing case is not a compile error there, but check). Both pass.

- [ ] **Step 5: Commit** `daemon: Add pendingOpen to the protocol`

---

### Task 3: Daemon handles pendingOpen

**Files:**
- Modify: `packages/daemon/src/daemon.ts` (after the `delete` case)
- Test: `packages/daemon/src/test/daemon.test.ts`

**Interfaces:**
- Consumes: `writePendingOpen`, `readPendingOpen` from Task 1.
- Produces: the daemon answers `pendingOpen` with `pendingOpenResult`; the file lands under `opts.home`.

- [ ] **Step 1: Write the failing tests**

`setup()` in the test file hard-codes `home: "/h"`. Add an option: `setup(opts: { debounceMs?: number; pollMs?: number; home?: string } = {})` and pass `home: opts.home ?? "/h"`.

```ts
test("pendingOpen writes the file under home and answers the requester", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-daemon-home-"));
  const h = setup({ home });
  const a = h.attach();
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  const session = s("claude", "a", { cwd: home });
  a.client.handle({ type: "pendingOpen", requestId: "1", session });
  await tick(20);
  assert.deepEqual(a.sent.at(-1), { type: "pendingOpenResult", requestId: "1", ok: true });
  assert.deepEqual((await readPendingOpen(home))?.session, session);
  h.daemon.stop();
});

test("pendingOpen reports a missing folder and needs the handshake", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-daemon-home-"));
  const h = setup({ home });
  const a = h.attach();
  a.client.handle({ type: "pendingOpen", requestId: "1", session: s("claude", "a", { cwd: home }) });
  assert.deepEqual(a.sent.at(-1), { type: "pendingOpenResult", requestId: "1", ok: false, error: "handshake required" });
  a.client.handle({ type: "hello", protocol: PROTOCOL_VERSION });
  a.client.handle({ type: "pendingOpen", requestId: "2", session: s("claude", "a", { cwd: join(home, "gone") }) });
  await tick(20);
  assert.deepEqual(a.sent.at(-1), { type: "pendingOpenResult", requestId: "2", ok: false, error: `${join(home, "gone")} does not exist` });
  h.daemon.stop();
});
```

Imports needed: `mkdtemp` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, `readPendingOpen` from `../pendingOpen.js`.

- [ ] **Step 2: Run** - fails: no answer is sent.

- [ ] **Step 3: Implement** in `daemon.ts`:

```ts
      case "pendingOpen":
        if (!client.greeted) {
          this.safeSend(client, { type: "pendingOpenResult", requestId: msg.requestId, ok: false, error: "handshake required" });
          return;
        }
        void this.pendingOpen(client, msg);
        return;
```

```ts
  /** Records a session for a window on its folder to open; see pendingOpen.ts. */
  private async pendingOpen(client: ClientState, msg: Extract<ClientMessage, { type: "pendingOpen" }>): Promise<void> {
    let error: string | undefined;
    try {
      await writePendingOpen(this.opts.home, msg.session, Date.now());
      this.log(`${msg.session.agent}: pending open of ${msg.session.id} in ${msg.session.cwd}`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.log(`${msg.session.agent}: pending open of ${msg.session.id} failed: ${error}`);
    }
    if (this.stopped) return;
    this.safeSend(client, error === undefined ? { type: "pendingOpenResult", requestId: msg.requestId, ok: true } : { type: "pendingOpenResult", requestId: msg.requestId, ok: false, error });
  }
```

Import `writePendingOpen` from `./pendingOpen.js`.

- [ ] **Step 4: Run** `npm test` in `packages/daemon` - pass.

- [ ] **Step 5: Commit** `daemon: Record a pending open on request`

---

### Task 4: LineClient and MachineConnection send pendingOpen

**Files:**
- Modify: `packages/extension/src/connection/lineClient.ts`
- Modify: `packages/extension/src/connection/machineConnection.ts:112-116`
- Test: `packages/extension/src/test/lineClient.test.ts`, `packages/extension/src/test/machineConnection.test.ts`

**Interfaces:**
- Produces: `LineClient.pendingOpen(session: SessionInfo): Promise<void>` and `MachineConnection.pendingOpen(session: SessionInfo): Promise<void>`, same rejection rules as `deleteSession`.

- [ ] **Step 1: Write the failing tests**

lineClient.test.ts:

```ts
test("pendingOpen sends the session and settles on the result", async () => {
  const h = harness();
  h.client.start();
  const session = { agent: "claude" as const, id: "a", title: "a", cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle" as const };
  const done = h.client.pendingOpen(session);
  await tick(5);
  const req = JSON.parse(h.sentToDaemon.find((l) => l.includes('"pendingOpen"'))!);
  assert.deepEqual(req.session, session);
  h.fromDaemon.write(JSON.stringify({ type: "pendingOpenResult", requestId: req.requestId, ok: false, error: "/w does not exist" }) + "\n");
  await assert.rejects(done, /\/w does not exist/);
  const ok = h.client.pendingOpen(session);
  await tick(5);
  const req2 = JSON.parse(h.sentToDaemon.find((l) => l.includes('"pendingOpen"') && !l.includes(`"requestId":"${req.requestId}"`))!);
  h.fromDaemon.write(JSON.stringify({ type: "pendingOpenResult", requestId: req2.requestId, ok: true }) + "\n");
  await ok;
  h.client.dispose();
});
```

machineConnection.test.ts:

```ts
test("pendingOpen goes through the connected daemon", async () => {
  const h = harness();
  const session = { agent: "claude" as const, id: "a", title: "a", cwd: "/w", createdAt: 1, updatedAt: 1, status: "idle" as const };
  await assert.rejects(h.conn.pendingOpen(session), /not connected/);
  h.conn.connect();
  await tick(5);
  h.procs[0].stdout.write(hello);
  await tick(5);
  const done = h.conn.pendingOpen(session);
  await tick(5);
  const req = JSON.parse(h.procs[0].received.find((l) => l.includes('"pendingOpen"'))!);
  h.procs[0].stdout.write(JSON.stringify({ type: "pendingOpenResult", requestId: req.requestId, ok: true }) + "\n");
  await done;
  h.conn.dispose();
});
```

- [ ] **Step 2: Run** `npm test` in `packages/extension` - compile error: `pendingOpen` does not exist.

- [ ] **Step 3: Implement.** In `lineClient.ts` factor the request bookkeeping out of `deleteSession`:

```ts
  /** Sends a request that the daemon answers by requestId; see deleteSession. */
  private request(build: (requestId: string) => ClientMessage, timeoutNote: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("not connected"));
    const requestId = String(++this.nextRequestId);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`no answer within ${Math.round(this.requestTimeoutMs / 1000)} s${timeoutNote}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.send(build(requestId));
    return done;
  }

  deleteSession(agent: AgentKind, id: string): Promise<void> {
    return this.request((requestId) => ({ type: "delete", requestId, agent, id }), "; the deletion may still complete");
  }

  /** Asks the daemon to record `session` for a window on its folder to open. */
  pendingOpen(session: SessionInfo): Promise<void> {
    return this.request((requestId) => ({ type: "pendingOpen", requestId, session }), "");
  }
```

and in `onLine`:

```ts
      case "pendingOpenResult":
        this.settle(msg.requestId, msg.ok ? undefined : new Error(msg.error ?? "pending open failed"));
        return;
```

Import `SessionInfo` type from `@agent-sessions/core`. In `machineConnection.ts` next to `deleteSession`:

```ts
  /** Records a pending open through the connected daemon; see LineClient.pendingOpen. */
  pendingOpen(session: SessionInfo): Promise<void> {
    if (!this.client || this.state !== "connected") return Promise.reject(new Error("not connected"));
    return this.client.pendingOpen(session);
  }
```

(copy the guard from `deleteSession` exactly as it is written there).

- [ ] **Step 4: Run** `npm test` in `packages/extension` - pass, the existing delete tests included.

- [ ] **Step 5: Commit** `extension: Send pendingOpen through the daemon connection`

---

### Task 5: Extension opens remote sessions and picks pending ones up from the file

**Files:**
- Modify: `packages/extension/src/claudeFolder.ts` (drop `PendingOpen`, `PENDING_OPEN_KEY`; add `remoteFolderUri`)
- Modify: `packages/extension/src/commands.ts` (`CommandDeps`, `offerClaudeFolder`, `openSession`)
- Modify: `packages/extension/src/extension.ts` (`sessionDeps`, `openPendingSession`)
- Test: `packages/extension/src/test/claudeFolder.test.ts`

**Interfaces:**
- Consumes: `MachineConnection.pendingOpen` (Task 4); `readPendingOpen`, `clearPendingOpen`, `PendingOpen` from `@agent-sessions/daemon` (Task 1).
- Produces:
  - `remoteFolderUri(sshHost: string, cwd: string): string` - `vscode-remote://ssh-remote+<host><cwd>`, cwd percent-encoded per path segment.
  - `CommandDeps.pendingOpen(machineId: string, session: SessionInfo): Promise<void>`
  - `CommandDeps.sshHost(machineId: string): string | undefined`

- [ ] **Step 1: Write the failing test** in `claudeFolder.test.ts`:

```ts
test("remoteFolderUri addresses the ssh host and keeps the path readable", () => {
  assert.equal(remoteFolderUri("dev-box", "/home/me/proj"), "vscode-remote://ssh-remote+dev-box/home/me/proj");
  assert.equal(remoteFolderUri("dev-box", "/home/me/my proj"), "vscode-remote://ssh-remote+dev-box/home/me/my%20proj");
});
```

Change the import of `PendingOpen` in this test file: `pendingSessionFor` keeps its signature but the type now comes from `@agent-sessions/daemon`; the test passes plain objects, so only add `remoteFolderUri` to the import.

- [ ] **Step 2: Run** - compile error: `remoteFolderUri` is not exported.

- [ ] **Step 3: Implement.**

`claudeFolder.ts`: remove the `PendingOpen` interface and `PENDING_OPEN_KEY`; `import type { PendingOpen } from "@agent-sessions/daemon";` for `pendingSessionFor`; add:

```ts
/** The folder `cwd` on the ssh host `sshHost`, as Remote-SSH addresses it. */
export function remoteFolderUri(sshHost: string, cwd: string): string {
  const path = cwd.split("/").map(encodeURIComponent).join("/");
  return `vscode-remote://ssh-remote+${sshHost}${path}`;
}
```

`commands.ts`:
- `CommandDeps`: replace `globalState: vscode.Memento;` with

```ts
  /** Records a session on its machine for a window on its folder to open. */
  pendingOpen(machineId: string, session: SessionInfo): Promise<void>;
  /** The ssh host of a remote machine, undefined for the local one. */
  sshHost(machineId: string): string | undefined;
```

- Drop `PENDING_OPEN_KEY`, `PendingOpen` from the `./claudeFolder.js` import; add `remoteFolderUri`.
- In `offerClaudeFolder`, replace the two `pending` lines with:

```ts
    try {
      await deps.pendingOpen("local", session);
    } catch (err) {
      void vscode.window.showErrorMessage(`Cannot hand the session over: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
```

- In `openSession`, replace the "later version" stub with:

```ts
  if (machineId !== "local") return openRemoteSession(deps, machineId, session);
```

and add above it:

```ts
/**
 * A remote session opens in a Remote-SSH window on its folder: the machine's
 * daemon records it, and the extension in that window picks it up on activation.
 */
async function openRemoteSession(deps: CommandDeps, machineId: string, session: SessionInfo): Promise<void> {
  const host = deps.sshHost(machineId);
  if (!host) return;
  if (!session.cwd) {
    void vscode.window.showWarningMessage(`"${session.title}" has no folder to open a remote window on.`);
    return;
  }
  try {
    await deps.pendingOpen(machineId, session);
  } catch (err) {
    void vscode.window.showErrorMessage(`Cannot open "${session.title}" on ${host}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(remoteFolderUri(host, session.cwd)), { forceNewWindow: true });
  deps.store.markRead(machineId, session, Date.now());
  deps.refresh();
}
```

`extension.ts`:
- Import `clearPendingOpen, readPendingOpen` from `@agent-sessions/daemon` (extend the existing import), drop `PENDING_OPEN_KEY`/`PendingOpen` from the `./claudeFolder.js` import.
- In `sessionDeps`, replace `globalState: context.globalState,` with:

```ts
    pendingOpen: (machineId, session) => {
      const c = connections.get(machineId);
      return c ? c.pendingOpen(session) : Promise.reject(new Error("the machine is not connected"));
    },
    sshHost: (machineId) => machines.machines.find((m) => m.id === machineId)?.sshHost,
```

- Replace `openPendingSession`:

```ts
  // A session that another window handed over to a window on its folder,
  // through the pending-open file of this machine (see daemon/pendingOpen.ts):
  // this window, when it has just been opened or, if it already existed, focused.
  const openPendingSession = async () => {
    const pending = await readPendingOpen(homedir());
    if (!pending) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const session = await pendingSessionFor(pending, folders, Date.now());
    if (!session) return;
    await clearPendingOpen(homedir());
    await openSession(sessionDeps, LOCAL_ID, session);
  };
```

`homedir` is already imported in `extension.ts`.

- [ ] **Step 4: Run** `npm test` in `packages/extension` and `npm run build` at the root - pass.

- [ ] **Step 5: Commit** `extension: Open remote sessions in their Remote-SSH window`

---

### Task 6: Docs

**Files:**
- Modify: `README.md` (Features "Opens in the native plugin", the "Open a Claude session of another folder" row, "Remote machines" feature)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README.** Add a table row after "Open a Claude session of another folder":

```
| Open a remote session | Double-click opens a Remote-SSH window on the session folder of that machine (or focuses the one already open) and opens the session there. The machine's daemon must speak the current protocol; run **Prepare Machine** after updating the extension. |
```

In "Remote machines" feature bullet append: "Double-clicking a remote session opens it in a Remote-SSH window on that machine."

- [ ] **Step 2: CHANGELOG.** Under an "Unreleased" heading at the top:

```
## Unreleased

- Remote sessions open in a Remote-SSH window on their folder. The daemon
  protocol is now 3; run Prepare Machine on remote machines after updating.
- The hand-over of a Claude session to a window on its folder goes through a
  file on the machine holding the session instead of VS Code's global state.
```

- [ ] **Step 3: Commit** `docs: Describe opening remote sessions`

---

### Manual verification (after Task 6)

1. Package the extension, install it, run Prepare Machine on a host.
2. Double-click a Claude session of that host with no remote window open: a Remote-SSH window opens on the folder and the session opens in Claude Code.
3. Repeat with that window already open: it gets focus and opens the session.
4. Repeat for a Codex session with `agentSessions.codex.openTarget` at `sidebar` and at `panel`. If the side bar route lands in the local window, force the panel route when `vscode.env.remoteName` is set and note it in the README.
