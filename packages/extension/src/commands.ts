import * as vscode from "vscode";
import { isValidSessionId, type AgentKind, type SessionInfo } from "@agent-sessions/core";
import { isSafeSessionId, type SessionStore } from "./state/sessionStore.js";
import { applyFilterPicks, buildFilterItems, type FilterPickId, type FilterState } from "./tree/filterPicker.js";
import type { SessionNode, TreeNode } from "./tree/treeModel.js";
import { selectionTargets } from "./tree/selection.js";

export type { FilterState };

export interface CommandDeps {
  store: SessionStore;
  refresh(): void;
  getFilter(): FilterState;
  setFilter(f: FilterState): void;
  /** Deletes a session through the daemon of its machine. */
  deleteSession(machineId: string, agent: AgentKind, id: string): Promise<void>;
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

const CODEX_EDITOR_VIEW_TYPE = "chatgpt.conversationEditor";

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

async function offerInstall(extensionId: string, name: string): Promise<void> {
  const pick = await vscode.window.showErrorMessage(`${name} extension is not installed.`, "Install");
  if (pick === "Install") await vscode.commands.executeCommand("workbench.extensions.installExtension", extensionId);
}

export async function openSession(deps: CommandDeps, machineId: string, session: SessionInfo): Promise<void> {
  if (machineId !== "local") {
    void vscode.window.showInformationMessage("Opening remote sessions will come in a later version.");
    return;
  }
  if (!checkSessionId(session.id)) return;
  if (session.agent === "claude") {
    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION)) return offerInstall(CLAUDE_EXTENSION, "Claude Code");
    await vscode.commands.executeCommand("claude-vscode.editor.open", session.id);
  } else if (session.agent === "codex") {
    if (!vscode.extensions.getExtension(CODEX_EXTENSION)) return offerInstall(CODEX_EXTENSION, "Codex");
    await openCodexThread(session.id);
  } else {
    void vscode.window.showInformationMessage(`Opening ${session.agent} sessions is not supported yet.`);
    return;
  }
  deps.store.markRead(machineId, session, Date.now());
  deps.refresh();
}

export function registerSessionCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const reg = (id: string, fn: (node?: TreeNode) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (node?: TreeNode) => fn(node)));
  // Multi-select aware: VS Code passes the clicked node and the selection.
  const regMulti = (id: string, fn: (targets: SessionNode[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (node?: TreeNode, selected?: TreeNode[]) => fn(selectionTargets(node, selected))),
    );

  reg("agentSessions.openSession", async (node) => {
    const s = sessionOf(node);
    if (s) await openSession(deps, s.machineId, s.session);
  });
  regMulti("agentSessions.markRead", (targets) => {
    const now = Date.now();
    for (const n of targets) deps.store.markRead(n.machineId, n.row.session, now);
    if (targets.length > 0) deps.refresh();
  });
  reg("agentSessions.markUnread", (node) => {
    const s = sessionOf(node);
    if (!s) return;
    deps.store.markUnread(s.machineId, s.session);
    deps.refresh();
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
  reg("agentSessions.copySessionId", async (node) => {
    const s = sessionOf(node);
    if (s && checkSessionId(s.session.id)) await vscode.env.clipboard.writeText(s.session.id);
  });
  reg("agentSessions.resumeInTerminal", (node) => {
    const s = sessionOf(node);
    if (!s || s.machineId !== "local" || !checkSessionId(s.session.id)) return;
    const cmd = s.session.agent === "claude" ? `claude --resume ${s.session.id}` : `codex resume ${s.session.id}`;
    const term = vscode.window.createTerminal({ name: `${s.session.agent}: ${s.session.title}`, cwd: s.session.cwd || undefined });
    term.show();
    term.sendText(cmd, false);
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
