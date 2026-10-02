# Changelog

## Unreleased

- The "Add Machine" button in the view header shows a remote-machine icon
  instead of a plus.
- Sessions can be pinned: the pin button on a session, or "Pin Session" in
  its context menu, keeps it at the top of its folder and adds a pin to its
  icon.
- A session under the pointer gets a hide button to the left of the pin; on
  a hidden session the same button unhides it.
- Sessions can be renamed: the pencil button on a session, to the left of
  the hide button, "Rename Session…" in its context menu, or F2. The name is
  written by the agent itself (the Agent SDK for Claude Code, `codex
  app-server` for Codex), so Claude Code and Codex show it too. The daemon
  protocol is now version 4; a running older daemon is replaced.
- A Claude Code session renamed while its tab is open is still marked read
  when the tab is viewed. The tab keeps its old label, so it is no longer
  matched by title alone: the sessions this window runs are known by their
  ids, and a tab whose label names none of them is the one left over.
- "New Session…" in a folder's context menu, or the plus button on the
  folder, starts a Claude Code or Codex session in that folder, opening a
  window on it when needed.
- A session whose tab is active in the focused window counts as read: work
  that finishes while you watch it, or that you return to by clicking its
  tab, no longer leaves it marked unread.

## 0.1.3 - 2026-09-29

- Folder context menu: mark the sessions of a folder read or unread, delete
  them, or hide the folder as a whole, independently of hiding its sessions.

## 0.1.2 - 2026-09-29

- Opening a session whose agent extension is missing installs it on request
  and then opens the session, instead of stopping after the install.

## 0.1.1 - 2026-09-29

- Remote sessions open in a Remote-SSH window on their folder. The daemon
  protocol is now 3; run Prepare Machine on remote machines after updating.
- The hand-over of a Claude session to a window on its folder goes through a
  file on the machine holding the session instead of VS Code's global state.

## 0.1.0 - 2026-09-29

First release.

- Claude Code and Codex sessions from the local machine in one tree, grouped
  by machine and project, with agent icons and relative activity times.
- Live status: running sessions get a green dot; long-silent Codex turns are
  not shown as running.
- Unread marks for sessions that finished work since you last opened them;
  opening a session in Claude Code or Codex does not count as activity.
- Open a session in the native plugin on double click (single click is a
  setting); "Resume in Terminal" prepares the CLI command.
- Hide, unhide, mark read or unread, copy the id, delete permanently; the
  hide, delete and mark-as-read commands apply to a multi-selection.
- Filter by agent, by the workspace open in the window, and by remote
  machines.
- Remote machines over ssh: hosts from `~/.ssh/config`, one-command
  preparation that installs the daemon and, when needed, Node 22.
- One shared local daemon per machine over a unix socket, restarted
  automatically after an extension update.
