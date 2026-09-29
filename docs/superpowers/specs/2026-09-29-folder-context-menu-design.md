# Folder context menu

## Goal

A project folder in the tree gets a context menu with mark as read, mark as
unread, hide, unhide and delete. Hiding a folder is independent of hiding
its sessions: hide one session, hide the folder, unhide the folder, and that
session stays hidden.

## Design

### Folder hidden mark

`SessionMarks` gains `hiddenProject/<machineId>/<cwd>` next to the existing
`hidden/<session key>` marks. Hiding or unhiding a folder changes only this
mark; session marks are untouched.

### Tree

- With "show hidden" off, a hidden folder is omitted with all its sessions.
- With "show hidden" on, a hidden folder is shown dimmed with the
  description `hidden`, and its sessions appear each with its own state.
- The folder's `contextValue` is `project:<hidden|visible>:<unread|read>`,
  `unread` when any shown session is unread.

### Commands

- `markRead`, `markUnread` and `deleteSession` accept a folder node:
  `selectionTargets` expands a folder into the sessions shown under it, so
  the existing logic applies, including the delete confirmation and the
  skipping of running sessions. Hidden sessions that are not shown are not
  affected.
- `hideProject` and `unhideProject` are new commands that set the folder
  mark. They act on the clicked folder only.
- `markUnread` becomes multi-select aware like `markRead`.

### Menu

Folder nodes show Mark as Read, Mark as Unread, Hide Folder, Unhide Folder
and Delete Sessions… in the same groups as the session commands; visibility
follows the folder's `contextValue`.

### Tests

- treeModel: a hidden folder disappears entirely and reappears with
  `showHidden`; folder contextValue.
- selection: a folder expands into its sessions; a folder selected together
  with one of its sessions yields no duplicates.
- marks / sessionStore: folder mark is independent of session marks.

## Out of scope

- Multi-select of several folders for hide and unhide.
- A separate read mark for folders.
