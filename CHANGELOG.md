# Changelog

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
