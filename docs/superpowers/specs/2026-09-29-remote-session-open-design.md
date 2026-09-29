# Opening remote sessions in their Remote-SSH window

## Goal

Double-clicking a session of a remote machine opens a VS Code Remote-SSH
window on the session folder of that host and opens the session there, in
the agent's own extension. The user sees the same behaviour as for a local
session of another folder, minus the confirmation dialog.

## Context

- The extension declares no `extensionKind`, so in a Remote-SSH window it
  runs on the remote host. There "This machine" is the remote host and
  opening a session goes through the ordinary local path.
- The remote daemon is spawned over ssh in `--stdio` mode. It is a separate
  process from the shared socket daemon that the extension in the remote
  window connects to, so hand-over state cannot live in daemon memory.
- The current hand-over between local windows uses `globalState`, which the
  remote extension host does not share.

## Design

### 1. Opening a remote session (`commands.ts`, `openSession`)

For `machineId !== "local"`:

1. Require a connected `MachineConnection` for the machine; otherwise show
   "machine is not connected" and stop.
2. Send `pendingOpen` with the `SessionInfo` to that machine's daemon and
   wait for the result. On error show the daemon's message, for example
   that the session folder no longer exists.
3. Run `vscode.openFolder` with
   `vscode-remote://ssh-remote+<sshHost><cwd>` and `forceNewWindow: true`.
   VS Code focuses an existing window on that folder instead of opening a
   second one.
4. Mark the session read, as for a local session.

`sshHost` is the ssh config alias stored in the machine record, which is
also what Remote-SSH uses as authority.

### 2. Daemon protocol (`protocol.ts`, version 3)

- Client: `{ type: "pendingOpen", requestId, session: SessionInfo }`.
- Daemon: `{ type: "pendingOpenResult", requestId, ok, error? }`.

The daemon checks that `session.cwd` is a directory, then writes
`~/.local/share/agent-sessions/pending-open.json` atomically with
`{ session, at }`. The path is fixed under home, not `XDG_RUNTIME_DIR`: the
ssh daemon runs without a login shell and may lack that variable while the
extension host in the remote window has it.

A daemon on the old protocol answers with a protocol error; the existing
mismatch handling offers Prepare Machine.

### 3. Pick-up in the target window (`extension.ts`, `openPendingSession`)

On activation and on window focus the extension reads the pending file from
the machine it runs on, applies the checks of `pendingSessionFor`
(freshness of two minutes, exact match of a workspace folder with
`session.cwd`, both canonicalised), deletes the file and opens the session
as local.

The local flow "Open Folder in New Window" uses the same path: the session
goes through `pendingOpen` to the local daemon. `globalState` leaves
`CommandDeps`; there is one mechanism.

### 4. Codex in a remote window

The panel route (`vscode.openWith`) works in a remote window. The side bar
route (`vscode.env.openExternal` with a `vscode://openai.chatgpt/...` URI)
is verified by hand during implementation. If it lands in the local window,
the extension uses the panel route whenever `vscode.env.remoteName` is set,
and the README says so.

### 5. Tests

- protocol: parsing of both new messages.
- daemon: `pendingOpen` writes the file; a missing cwd yields an error
  result.
- claudeFolder: the file reader handles a missing file, broken JSON and a
  stale entry; `pendingSessionFor` keeps its tests.
- commands: the `vscode-remote` URI built from `sshHost` and `cwd` (pure
  function).
- Manual: double-click a Claude and a Codex session on a real host, with
  and without a remote window already open on the folder.

## Out of scope

- "Resume in Terminal" for remote sessions.
- Windows hosts.
- Git worktree matching for remote sessions; only an exact folder match, as
  `pendingSessionFor` does today.
