# Agent Sessions

All your AI coding sessions in one VS Code side bar: Claude Code and Codex,
on this machine and on remote machines over ssh, with live statuses, unread
marks, and one-click resume in the agent's own plugin.

VS Code's built-in "Chat Sessions" view only knows the agents that plug into
it, does not tell Claude sessions from Codex ones, and opens Claude sessions
in Copilot rather than in the Claude Code extension. Agent Sessions reads the
agents' own session stores instead and stays out of their way.

![The Agent Sessions view: sessions of two agents grouped by machine and project, with running and unread marks](https://raw.githubusercontent.com/navoff/vscode-agent-sessions/main/media/screenshot.png)

![The tray menu: the sessions that wait for you, each with its agent icon, and the tray icon with a dot](https://raw.githubusercontent.com/navoff/vscode-agent-sessions/main/media/tray-menu.png)

## Features

- **One tree for every agent.** Sessions are grouped by machine and project.
  Each row shows the agent icon, the title the agent gave the session, and how
  long ago it was last active.
- **Live status.** A running session gets a green dot. Claude Code status
  comes from its process registry; Codex status comes from the last turn
  event in the rollout, so an abandoned turn is not shown as running forever.
- **Unread marks.** A session that finished work since you last opened it is
  marked with `●`. Opening a session in Claude Code or Codex does not count
  as activity, so merely looking at old sessions keeps them read. A session
  whose tab is active in the focused window is read as it goes.
- **Badge, notifications and a tray icon.** The number of sessions that
  finished work and wait for you is shown on the Agent Sessions icon in the
  activity bar, and each such session is announced once: on Linux with a
  system notification from a small tray helper, elsewhere with a VS Code
  message with an "Open" button; several sessions that finish at once are
  summed up in one notification. The tray icon lists those sessions in its
  menu and gets a dot while any wait. The tray helper is used only in local
  windows; a Remote-SSH window shows VS Code messages.
- **Opens in the native plugin.** Double-click a Claude session and it opens
  in the Claude Code extension; a Codex session opens in the Codex plugin,
  in its side bar or in an editor tab. "Resume in Terminal" prepares the CLI
  command instead.
- **Remote machines.** Add any host from `~/.ssh/config`. The extension
  installs a small daemon on the remote machine, brings its own Node when the
  host has none, and streams that machine's sessions into the same tree.
- **Housekeeping.** Pin the sessions you keep coming back to, rename them,
  hide the ones you no longer care about, mark them read or unread, delete
  them for good, and apply most of that to a multi-selection.
- **One daemon per machine.** All VS Code windows share one background
  process, so opening a second window does not rescan anything.

## Requirements

- VS Code 1.96 or newer on Linux or macOS. Windows is not supported.
- The [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
  and [Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt)
  extensions for opening sessions in place. Listing sessions works without
  them.
- For remote machines: ssh access that works without prompts
  (`BatchMode=yes`), and either Node 20+ on the host or the ability to
  download Node 22 from nodejs.org.
- For the tray icon: Linux with a StatusNotifier host in the panel (GNOME
  with the AppIndicator extension, KDE, Cinnamon, XFCE, MATE). The helper opens sessions through the `code` CLI of
  the running VS Code (falling back to `xdg-open` with the `vscode` URL
  scheme).

## Getting started

1. Install the extension and reload the window. The **Agent Sessions** icon
   appears in the activity bar.
2. "This machine" connects on its own and lists the sessions found in
   `~/.claude` and `~/.codex`.
3. To watch a remote machine, click **Add Machine** in the view header, pick
   a host from your ssh config, and let **Prepare Machine** finish. The
   machine then connects and shows its sessions.

## Working with sessions

| Action | How |
| --- | --- |
| Open a session | Double-click it (or single-click with `agentSessions.openOn` set to `singleClick`). "Open Session" in the context menu always opens immediately. |
| Open a Claude session of another folder | Claude Code finds only sessions of the folder open in its window and its git worktrees, so such a session offers "Open Folder in New Window", which then opens the session there, or "Resume in Terminal". |
| Resume in a terminal | "Resume in Terminal" opens a terminal in the session folder with `claude --resume <id>` or `codex resume <id>` typed in, not run. |
| Start a new session | The plus button that appears on a folder under the pointer, or "New Session…" in its context menu, asks for the agent, Claude Code or Codex, and starts a session in that folder: in this window when the folder is open in it, otherwise in a new window on the folder, a Remote-SSH one for a remote machine. |
| Mark read / unread | Context menu. Opening a session marks it read, and so does having its editor tab active in the focused window: switching to the tab or back to the window clears the mark. A session shown in the Claude Code or Codex sidebar is not detected. |
| Hide / unhide | The crossed-out eye button that appears on a session under the pointer, to the left of the pin, or "Hide Session" in the context menu, removes the session from the tree; the eye button in the header shows hidden sessions dimmed with the word `hidden`. On a hidden session the button turns into an eye that brings the session back. |
| Pin / unpin | The pin button that appears on a session under the pointer, or "Pin Session" in the context menu, moves the session to the top of its folder and adds a pin to its icon. The same button on a pinned session unpins it. |
| Rename | The pencil button that appears on a Claude Code or Codex session under the pointer, to the left of the eye, "Rename Session…" in the context menu, or F2 in the focused list asks for a new name and has the agent itself write it, see below. |
| Move to another folder | Drag a Claude Code or Codex session, or several selected ones, onto a folder of the same machine, or onto a session in it; the drop asks once and moves them, see below. Opening a session of another folder also offers to move it to the folder of the window. |
| See what a session is about | Hover a session: the tooltip shows its full title, the start of the first prompt and the time of the last update. |
| Order | Sessions in a folder go by creation time, newest first, with pinned ones above the rest. Activity does not move a session. |
| Delete | "Delete Session…" or the Delete key (Cmd+Backspace on macOS) in the focused list asks once and deletes permanently, see below. |
| Several at once | Shift-click and Ctrl-click select several sessions; pin, hide, delete and mark-as-read then apply to the whole selection. |
| See what waits for you | The badge on the Agent Sessions icon counts unread sessions that are not hidden, on every machine, whatever the view filter. On Linux the same list is in the menu of the tray icon; a click opens a Claude Code session in the window that has its folder open, bringing that window to the front, or in a new window on the folder when none has it; a Codex session opens in the last active window. |
| Copy the id | "Copy Session ID". |

### Filter

The **Filter Sessions** button opens one list with three sections:

- **Agents**: which agents to show.
- **Projects**: "Only the workspace open in this window" keeps, on this
  machine, the sessions whose folder is open in the window. Remote machines
  are not affected. It is on in a newly opened workspace.
- **Remote machines**: "Show remote machines" toggles the remote machines,
  same as the header button.

The button icon is filled while the filter restricts anything. The filter is
remembered per window.

### Renaming sessions

A new name is written by the agent's own tooling on the machine that holds
the session, so Claude Code and Codex show it too, in `claude --resume`,
`codex resume` and their VS Code extensions, and it works for remote
machines:

- Claude Code: `renameSession` from the Agent SDK appends a title to the
  session file, as `/rename` does.
- Codex: a `thread/name/set` request to a `codex app-server` started for it
  lets Codex update its own session index.

A session that is running or open in its agent can be renamed as well. A
Codex window that has the session open may show the old name until it is
reloaded.

### Moving sessions to another folder

Claude Code opens only the sessions of the folder open in its window. A
Claude Code session can be moved to another folder of its machine instead
of opening a window on its own folder; it also works for remote machines.
The move is done the way Claude Code does it when the working directory of
a session changes: the session file and its directory of subagent
transcripts and tool results go to the project folder of the new directory
under `~/.claude/projects`, and a `relocated` entry appended to the file
names that directory. Claude Code then lists and continues the session in
the new folder; the paths in its history stay as they were.

A session that is open in Claude Code is not moved: close it there first.
Neither is a session to a folder that does not exist or whose path is
longer than 200 characters. The window the move was made from does not
open the session.

A Codex session opens in any window, so moving it only changes the folder
it is listed under and works in. Codex does it itself: a `thread/resume`
request with the new working directory to a `codex app-server` started for
it makes Codex record the directory in the session file and in its state,
with the other settings of the session kept. The session file stays where
it is. A Codex session that is running or open in Codex is not moved, and
a Codex window may show the old folder until it is reloaded.

### Deleting sessions

Deletion is permanent and is carried out by the agent's own tooling on the
machine that holds the session, so it also works for remote machines:

- Claude Code: `deleteSession` from the Agent SDK removes the session file and
  its subagent transcripts.
- Codex: `codex delete --force <id>` lets Codex update its own indexes.

A running session cannot be deleted. A session that is currently loaded in
the Codex plugin cannot be deleted either, because Codex holds a lock on it
until the window is reloaded; the error message says so.

## Remote machines

**Add Machine** lists the `Host` entries of `~/.ssh/config`. The extension
stores only the host name in its own `machines.json`; address, user and key
stay in your ssh config.

**Prepare Machine** runs over ssh: it checks the platform (Linux or macOS,
x64 or arm64), looks for Node 20+, downloads Node 22.15.0 into
`~/.local/share/agent-sessions/` when there is none, copies the daemon there
and verifies it. Run it again after updating the extension.

The ssh connection uses `BatchMode=yes`, `RemoteCommand=none` and
`RequestTTY=no`, so hosts that force an interactive shell in ssh config still
work, and no password prompt can appear.

Opening a remote session in place is not possible yet; remote sessions are
shown with their status and can be hidden, marked and deleted.

## The local daemon

One `daemon.mjs --listen` process per machine serves every VS Code window
over a unix socket. The first window starts it, later windows attach, and it
exits by itself after 60 seconds without clients.

- Socket, pid and log: `$XDG_RUNTIME_DIR/agent-sessions/` on Linux,
  `~/.local/share/agent-sessions/` where `XDG_RUNTIME_DIR` is not set (macOS).
- The directory is private (`0700`); a directory left with wider permissions
  is narrowed, one owned by someone else is refused.
- The daemon inherits the environment of the window that started it
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH`).
- After an extension update the windows notice the version mismatch and
  restart the daemon. **Restart Local Daemon** does the same by hand and
  kills a daemon that does not exit.

If "This machine" stays disconnected, run **Restart Local Daemon** and look
at **Show Log**; the daemon's own log is `daemon.log` next to the socket.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `agentSessions.openOn` | `doubleClick` | Open a session on double click; `singleClick` opens on the first click. |
| `agentSessions.codex.openTarget` | `sidebar` | Open Codex sessions in the Codex side bar or in an editor `panel`. |
| `agentSessions.showHidden` | `false` | Show hidden sessions in the tree. |
| `agentSessions.autoConnectOnStartup` | `true` | Connect the local machine and machines marked `autoConnect` on startup. |
| `agentSessions.notifications` | `true` | Announce a session that finished work and waits: a system notification on Linux with the tray helper, a VS Code message otherwise. More than three at once are summed up in one notification. |
| `agentSessions.ssh.path` | `ssh` | The ssh binary used for remote machines. |
| `agentSessions.tray` | `true` | Show the icon in the system tray. Linux only, local windows only (not Remote-SSH). |

Machines are kept in `machines.json` under the extension's global storage;
the file can be edited by hand (for example to set `"autoConnect": true`).

## Credits

The Codex rollout discovery and parsing was ported from
[Codex History Viewer](https://github.com/hiztam/codex-history-viewer) (MIT).
See `THIRD_PARTY_NOTICES.md`.

## License

MIT
