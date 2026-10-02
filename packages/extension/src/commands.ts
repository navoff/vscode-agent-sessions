import * as vscode from "vscode";
import { isValidSessionId, type AgentKind, type SessionInfo } from "@agent-sessions/core";
import { isSafeSessionId, type SessionStore } from "./state/sessionStore.js";
import { applyFilterPicks, buildFilterItems, type FilterPickId, type FilterState } from "./tree/filterPicker.js";
import type { ProjectNode, SessionNode, TreeNode } from "./tree/treeModel.js";
import { selectionTargets } from "./tree/selection.js";
import { DoubleClickDetector } from "./tree/clickDetector.js";
import { claudeFindsSession, isDirectory, isWindowFolder, newSessionRequest, remoteFolderUri } from "./claudeFolder.js";

export type { FilterState };

export interface CommandDeps {
  store: SessionStore;
  refresh(): void;
  getFilter(): FilterState;
  setFilter(f: FilterState): void;
  /** Deletes a session through the daemon of its machine. */
  deleteSession(machineId: string, agent: AgentKind, id: string): Promise<void>;
  /** Current tree selection, for commands run from a keybinding. */
  selection(): readonly TreeNode[];
  /** Records a session on its machine for a window on its folder to open. */
  pendingOpen(machineId: string, session: SessionInfo): Promise<void>;
  /** The ssh host of a remote machine, undefined for the local one. */
  sshHost(machineId: string): string | undefined;
  log: vscode.OutputChannel;
}

const CLAUDE_EXTENSION = "anthropic.claude-code";
const CODEX_EXTENSION = "openai.chatgpt";

function sessionOf(node: TreeNode | undefined): { machineId: string; session: SessionInfo } | undefined {
  if (!node || node.kind !== "session") return undefined;
  return { machineId: node.machineId, session: node.row.session };
}

function checkSessionId(id: string): boolean {
  if (isSafeSessionId(id)) return true;
  void vscode.window.showErrorMessage(`Session id ${JSON.stringify(id.slice(0, 80))} has unexpected characters, ignoring.`);
  return false;
}

export const CODEX_EDITOR_VIEW_TYPE ="chatgpt.conversationEditor";

/** Codex custom-editor URI for a local thread: openai-codex://route/local/<id>. */
export function codexConversationUri(sessionId: string): vscode.Uri {
  return vscode.Uri.file(`/local/${sessionId}`).with({ scheme: "openai-codex", authority: "route" });
}

async function openCodexThread(sessionId: string): Promise<void> {
  const target = vscode.workspace.getConfiguration("agentSessions").get<string>("codex.openTarget", "sidebar");
  if (target === "panel") {
    await vscode.commands.executeCommand("vscode.openWith", codexConversationUri(sessionId), CODEX_EDITOR_VIEW_TYPE, {
      preview: false,
      preserveFocus: false,
    });
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(`vscode://openai.chatgpt/local/${encodeURIComponent(sessionId)}`));
}

/** Resolves once `extensionId` is installed, or false after `timeoutMs`. */
function waitForExtension(extensionId: string, timeoutMs: number): Promise<boolean> {
  if (vscode.extensions.getExtension(extensionId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(timer); sub.dispose(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    const sub = vscode.extensions.onDidChange(() => { if (vscode.extensions.getExtension(extensionId)) done(true); });
  });
}

/** Offers to install `extensionId`; true once it is installed and the caller can go on. */
async function offerInstall(extensionId: string, name: string): Promise<boolean> {
  const pick = await vscode.window.showErrorMessage(`${name} extension is not installed.`, "Install");
  if (pick !== "Install") return false;
  try {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", extensionId);
  } catch (err) {
    void vscode.window.showErrorMessage(`Installing ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (await waitForExtension(extensionId, 30_000)) return true;
  void vscode.window.showWarningMessage(`${name} did not become available; open the session again once it is installed.`);
  return false;
}

function resumeInTerminal(session: SessionInfo): void {
  const cmd = session.agent === "claude" ? `claude --resume ${session.id}` : `codex resume ${session.id}`;
  const term = vscode.window.createTerminal({ name: `${session.agent}: ${session.title}`, cwd: session.cwd || undefined });
  term.show();
  term.sendText(cmd, false);
}

/** A folder of the machine this window runs on; in a remote window that is the remote host. */
function localFolderUri(cwd: string): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri;
  return base && base.scheme !== "file" ? base.with({ path: cwd }) : vscode.Uri.file(cwd);
}

/**
 * Claude Code opens a session of another folder as an empty conversation, so
 * offer to open that folder in a new window, which then opens the session.
 */
async function offerClaudeFolder(deps: CommandDeps, session: SessionInfo): Promise<void> {
  const why = "Claude Code opens only sessions of the folder open in its window.";
  if (!(await isDirectory(session.cwd))) {
    void vscode.window.showWarningMessage(`"${session.title}" was started in ${session.cwd}, which no longer exists. ${why}`);
    return;
  }
  const newWindow = "Open Folder in New Window";
  const terminal = "Resume in Terminal";
  const pick = await vscode.window.showInformationMessage(`"${session.title}" belongs to ${session.cwd}. ${why}`, newWindow, terminal);
  if (pick === newWindow) {
    try {
      await deps.pendingOpen("local", session);
    } catch (err) {
      void vscode.window.showErrorMessage(`Cannot hand the session over: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await vscode.commands.executeCommand("vscode.openFolder", localFolderUri(session.cwd), { forceNewWindow: true });
  } else if (pick === terminal) {
    resumeInTerminal(session);
  }
}

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

export async function openSession(deps: CommandDeps, machineId: string, session: SessionInfo): Promise<void> {
  if (machineId !== "local") return openRemoteSession(deps, machineId, session);
  if (!checkSessionId(session.id)) return;
  if (session.agent === "claude") {
    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION) && !(await offerInstall(CLAUDE_EXTENSION, "Claude Code"))) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!(await claudeFindsSession(session.cwd, folders))) return offerClaudeFolder(deps, session);
    await vscode.commands.executeCommand("claude-vscode.editor.open", session.id);
  } else if (session.agent === "codex") {
    if (!vscode.extensions.getExtension(CODEX_EXTENSION) && !(await offerInstall(CODEX_EXTENSION, "Codex"))) return;
    await openCodexThread(session.id);
  } else {
    void vscode.window.showInformationMessage(`Opening ${session.agent} sessions is not supported yet.`);
    return;
  }
  deps.store.markRead(machineId, session, Date.now());
  deps.refresh();
}

/** Starts a new session of `agent` in this window; its extension uses the window folder. */
export async function startNewSession(agent: AgentKind): Promise<void> {
  if (agent === "claude") {
    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION) && !(await offerInstall(CLAUDE_EXTENSION, "Claude Code"))) return;
    await vscode.commands.executeCommand("claude-vscode.editor.open");
  } else if (agent === "codex") {
    if (!vscode.extensions.getExtension(CODEX_EXTENSION) && !(await offerInstall(CODEX_EXTENSION, "Codex"))) return;
    const target = vscode.workspace.getConfiguration("agentSessions").get<string>("codex.openTarget", "sidebar");
    if (target === "panel") {
      await vscode.commands.executeCommand("chatgpt.newCodexPanel");
      return;
    }
    await vscode.commands.executeCommand("chatgpt.openSidebar");
    await vscode.commands.executeCommand("chatgpt.newChat");
  } else {
    void vscode.window.showInformationMessage(`Starting ${agent} sessions is not supported yet.`);
  }
}

const NEW_SESSION_AGENTS: (vscode.QuickPickItem & { agent: AgentKind })[] = [
  { label: "Claude Code", agent: "claude" },
  { label: "Codex", agent: "codex" },
];

/**
 * Starts a new session in the folder of `node`: here when the window is on
 * that folder, otherwise in a window opened on it, which picks the request up
 * like a handed-over session.
 */
async function newSession(deps: CommandDeps, node: ProjectNode): Promise<void> {
  if (!node.cwd) {
    void vscode.window.showWarningMessage("These sessions have no folder to start a new session in.");
    return;
  }
  if (node.machineId === "local" && !(await isDirectory(node.cwd))) {
    void vscode.window.showWarningMessage(`${node.cwd} no longer exists, so a session cannot be started in it.`);
    return;
  }
  const pick = await vscode.window.showQuickPick(NEW_SESSION_AGENTS, { title: `New session in ${node.label}` });
  if (!pick) return;
  let uri: vscode.Uri;
  if (node.machineId === "local") {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (await isWindowFolder(node.cwd, folders)) return startNewSession(pick.agent);
    uri = localFolderUri(node.cwd);
  } else {
    const host = deps.sshHost(node.machineId);
    if (!host) return;
    uri = vscode.Uri.parse(remoteFolderUri(host, node.cwd));
  }
  try {
    await deps.pendingOpen(node.machineId, newSessionRequest(pick.agent, node.cwd, Date.now()));
  } catch (err) {
    void vscode.window.showErrorMessage(`Cannot start a session in ${node.cwd}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
}

export function registerSessionCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const reg = (id: string, fn: (node?: TreeNode) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (node?: TreeNode) => fn(node)));
  // Multi-select aware: a context menu passes the clicked node and the
  // selection; a keybinding passes nothing, so read the selection from the tree.
  const regMulti = (id: string, fn: (targets: SessionNode[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (node?: TreeNode, selected?: TreeNode[]) =>
        fn(selectionTargets(node, node ? selected : deps.selection())),
      ),
    );

  reg("agentSessions.openSession", async (node) => {
    const s = sessionOf(node);
    if (s) await openSession(deps, s.machineId, s.session);
  });
  // Tree item clicks: a single click only selects when agentSessions.openOn is
  // "doubleClick" (the default); the context menu command above always opens.
  const clicks = new DoubleClickDetector();
  reg("agentSessions.clickSession", async (node) => {
    const s = sessionOf(node);
    if (!s) return;
    const mode = vscode.workspace.getConfiguration("agentSessions").get<string>("openOn", "doubleClick");
    if (mode === "doubleClick" && !clicks.click(`${s.machineId}/${s.session.agent}:${s.session.id}`)) return;
    await openSession(deps, s.machineId, s.session);
  });
  reg("agentSessions.newSession", async (node) => {
    if (node?.kind === "project") await newSession(deps, node);
  });
  regMulti("agentSessions.markRead", (targets) => {
    const now = Date.now();
    for (const n of targets) deps.store.markRead(n.machineId, n.row.session, now);
    if (targets.length > 0) deps.refresh();
  });
  regMulti("agentSessions.markUnread", (targets) => {
    for (const n of targets) deps.store.markUnread(n.machineId, n.row.session);
    if (targets.length > 0) deps.refresh();
  });
  regMulti("agentSessions.hideSession", (targets) => {
    for (const n of targets) deps.store.setHidden(n.machineId, n.row.session, true);
    if (targets.length > 0) deps.refresh();
  });
  reg("agentSessions.unhideSession", (node) => {
    const s = sessionOf(node);
    if (!s) return;
    deps.store.setHidden(s.machineId, s.session, false);
    deps.refresh();
  });
  const setPinned = (targets: SessionNode[], pinned: boolean) => {
    for (const n of targets) deps.store.setPinned(n.machineId, n.row.session, pinned);
    if (targets.length > 0) deps.refresh();
  };
  regMulti("agentSessions.pinSession", (targets) => setPinned(targets, true));
  regMulti("agentSessions.unpinSession", (targets) => setPinned(targets, false));
  // Folder hiding is a mark of its own, so the sessions keep theirs.
  const setProjectHidden = (node: TreeNode | undefined, hidden: boolean) => {
    if (!node || node.kind !== "project") return;
    deps.store.setProjectHidden(node.machineId, node.cwd, hidden);
    deps.refresh();
  };
  reg("agentSessions.hideProject", (node) => setProjectHidden(node, true));
  reg("agentSessions.unhideProject", (node) => setProjectHidden(node, false));
  reg("agentSessions.copySessionId", async (node) => {
    const s = sessionOf(node);
    if (s && checkSessionId(s.session.id)) await vscode.env.clipboard.writeText(s.session.id);
  });
  reg("agentSessions.resumeInTerminal", (node) => {
    const s = sessionOf(node);
    if (!s || s.machineId !== "local" || !checkSessionId(s.session.id)) return;
    resumeInTerminal(s.session);
  });
  regMulti("agentSessions.deleteSession", async (targets) => {
    const skipped: string[] = [];
    const candidates = targets.filter((n) => {
      const { session } = n.row;
      // The daemon only deletes UUID ids; say so here instead of after the round trip.
      if (!isValidSessionId(session.id)) {
        skipped.push(`"${session.title}": id is not a session UUID`);
        return false;
      }
      if (session.status === "running") {
        skipped.push(`"${session.title}": running`);
        return false;
      }
      return true;
    });
    if (skipped.length > 0) void vscode.window.showWarningMessage(`Skipped: ${skipped.join("; ")}`);
    if (candidates.length === 0) return;
    const titles = candidates.map((n) => `"${n.row.session.title}"`);
    const shown = titles.length > 5 ? `${titles.slice(0, 5).join(", ")} and ${titles.length - 5} more` : titles.join(", ");
    const closeFirst = candidates.some((n) => n.row.session.agent === "codex") ? " Close Codex sessions first if they are open." : "";
    const what = candidates.length === 1 ? `Delete ${shown} permanently?` : `Delete ${candidates.length} sessions permanently? ${shown}.`;
    const pick = await vscode.window.showWarningMessage(`${what} This cannot be undone.${closeFirst}`, { modal: true }, "Delete");
    if (pick !== "Delete") return;
    const failed: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: candidates.length === 1 ? `Deleting ${shown}` : `Deleting ${candidates.length} sessions` }, async () => {
      for (const n of candidates) {
        const { machineId } = n;
        const { session } = n.row;
        try {
          await deps.deleteSession(machineId, session.agent, session.id);
          deps.log.appendLine(`[${machineId}] deleted ${session.agent}:${session.id}`);
          deps.store.forget(machineId, session);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          deps.log.appendLine(`[${machineId}] delete ${session.agent}:${session.id} failed: ${msg}`);
          failed.push(`"${session.title}": ${msg}`);
        }
      }
    });
    if (failed.length > 0) void vscode.window.showErrorMessage(`Could not delete ${failed.join("; ")}`);
    deps.refresh();
  });
  reg("agentSessions.refresh", () => deps.refresh());
  reg("agentSessions.showLog", () => deps.log.show());
  reg("agentSessions.toggleRemote", () => {
    const f = deps.getFilter();
    deps.setFilter({ ...f, showRemote: !f.showRemote });
    deps.refresh();
  });
  const toggleHidden = async () => {
    const cfg = vscode.workspace.getConfiguration("agentSessions");
    await cfg.update("showHidden", !cfg.get<boolean>("showHidden", false), vscode.ConfigurationTarget.Global);
    deps.refresh();
  };
  reg("agentSessions.toggleHidden", toggleHidden);
  reg("agentSessions.toggleHiddenActive", toggleHidden);
  const filterSessions = async () => {
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const items = buildFilterItems(deps.getFilter(), hasWorkspace).map((i): vscode.QuickPickItem & { id?: FilterPickId } =>
      i.kind === "separator"
        ? { label: i.label, kind: vscode.QuickPickItemKind.Separator }
        : { id: i.id, label: i.label, description: i.description, picked: i.picked },
    );
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: "Filter sessions" });
    if (!picks) return;
    const ids = picks.flatMap((p) => ((p as { id?: FilterPickId }).id ? [(p as { id: FilterPickId }).id] : []));
    deps.setFilter(applyFilterPicks(ids));
    deps.refresh();
  };
  reg("agentSessions.filterAgents", filterSessions);
  reg("agentSessions.filterSessionsActive", filterSessions);
}
