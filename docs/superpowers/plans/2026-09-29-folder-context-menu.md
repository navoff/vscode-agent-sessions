# Folder Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Folder nodes get mark read/unread, hide/unhide and delete, with folder hiding independent of session hiding.

**Architecture:** A `hiddenProject/<machine>/<cwd>` mark next to session marks; `buildTree` drops hidden folders unless `showHidden`; `selectionTargets` expands folder nodes into their shown sessions so the existing multi-select commands apply; two new commands set the folder mark.

**Tech Stack:** TypeScript, `node --test`, VS Code tree view API.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-29-folder-context-menu-design.md`.
- Folder commands act only on sessions shown under the folder.
- English strings in code and docs; `"` and `-` in prose.

---

### Task 1: Folder hidden mark (marks.ts, sessionStore.ts, tests)

- [ ] `SessionMarks.isProjectHidden(machineId, cwd)` / `setProjectHidden(machineId, cwd, hidden)` on key `hiddenProject/<machineId>/<cwd>`.
- [ ] `SessionStore.isProjectHidden` / `setProjectHidden` delegate to marks.
- [ ] Test in `sessionStore.test.ts`: hiding a folder leaves session marks alone and vice versa.

### Task 2: Tree (treeModel.ts, treeProvider.ts, tests)

- [ ] `ProjectNode` gains `hidden: boolean` and `unread: boolean`; `BuildOptions` gains `isProjectHidden?: (machineId: string, cwd: string) => boolean`.
- [ ] `buildTree` skips hidden folders unless `filter.showHidden`; `projectContextValue(node)` returns `project:<hidden|visible>:<unread|read>`.
- [ ] Provider: description `hidden`, dimmed folder icon, contextValue from `projectContextValue`; `extension.ts` passes `isProjectHidden` from the store.
- [ ] Tests in `treeModel.test.ts`: hidden folder gone without `showHidden`, present with it, session marks untouched; contextValue.

### Task 3: Selection and commands (selection.ts, commands.ts, package.json, tests)

- [ ] `selectionTargets` expands folder nodes (clicked or selected) into their sessions; machines are still ignored.
- [ ] `markUnread` uses `regMulti`; new `agentSessions.hideProject` / `unhideProject` commands on a folder node.
- [ ] Manifest: "Hide Folder" / "Unhide Folder" commands, folder menu entries in groups `2_marks` and `9_delete`, palette hidden.
- [ ] Tests in `selection.test.ts`: folder expands; folder plus its session yields no duplicates.

### Task 4: Docs

- [ ] README table row "Folder actions"; CHANGELOG entry under a new Unreleased heading.
