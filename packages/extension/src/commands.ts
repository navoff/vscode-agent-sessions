import * as vscode from "vscode";
import type { AgentKind, SessionInfo } from "@agent-sessions/core";
import { isSafeSessionId, type SessionStore } from "./state/sessionStore.js";
import type { TreeNode } from "./tree/treeModel.js";

export interface FilterState {
  agents: AgentKind[] | undefined;
  showRemote: boolean;
}

export interface CommandDeps {
  store: SessionStore;
  refresh(): void;
  getFilter(): FilterState;
  setFilter(f: FilterState): void;
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

  reg("agentSessions.openSession", async (node) => {
    const s = sessionOf(node);
    if (s) await openSession(deps, s.machineId, s.session);
  });
  reg("agentSessions.markRead", (node) => {
    const s = sessionOf(node);
    if (!s) return;
    deps.store.markRead(s.machineId, s.session, Date.now());
    deps.refresh();
  });
  reg("agentSessions.markUnread", (node) => {
    const s = sessionOf(node);
    if (!s) return;
    deps.store.markUnread(s.machineId, s.session);
    deps.refresh();
  });
  reg("agentSessions.hideSession", (node) => {
    const s = sessionOf(node);
    if (!s) return;
    deps.store.setHidden(s.machineId, s.session, true);
    deps.refresh();
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
  reg("agentSessions.refresh", () => deps.refresh());
  reg("agentSessions.showLog", () => deps.log.show());
  reg("agentSessions.toggleRemote", () => {
    const f = deps.getFilter();
    deps.setFilter({ ...f, showRemote: !f.showRemote });
    deps.refresh();
  });
  reg("agentSessions.toggleHidden", async () => {
    const cfg = vscode.workspace.getConfiguration("agentSessions");
    await cfg.update("showHidden", !cfg.get<boolean>("showHidden", false), vscode.ConfigurationTarget.Global);
    deps.refresh();
  });
  reg("agentSessions.filterAgents", async () => {
    const all: AgentKind[] = ["claude", "codex", "opencode"];
    const current = deps.getFilter().agents;
    const picks = await vscode.window.showQuickPick(
      all.map((a) => ({ label: a, picked: !current || current.includes(a) })),
      { canPickMany: true, title: "Show sessions of agents" },
    );
    if (!picks) return;
    const chosen = picks.map((p) => p.label as AgentKind);
    deps.setFilter({ ...deps.getFilter(), agents: chosen.length === all.length ? undefined : chosen });
    deps.refresh();
  });
}
