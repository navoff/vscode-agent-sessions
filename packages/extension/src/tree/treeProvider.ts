import * as vscode from "vscode";
import { buildTree, sessionDescription, sessionIconName, type MachineInput, type MachineNode, type TreeNode } from "./treeModel.js";
import type { SessionRow } from "../state/sessionStore.js";

export interface TreeSource {
  machines(): MachineInput[];
  rows(): Map<string, SessionRow[]>;
  filter(): { agents: Set<"claude" | "codex" | "opencode"> | undefined; showRemote: boolean; showHidden: boolean };
  machineEnabled(machineId: string): boolean;
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tree: MachineNode[] = [];

  constructor(private readonly source: TreeSource, private readonly resources: vscode.Uri, private readonly home: string) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      this.tree = buildTree(this.source.machines(), this.source.rows(), this.source.filter(), { home: this.home, workspaceFolders: folders });
      return this.tree;
    }
    if (element.kind === "machine") return element.projects;
    if (element.kind === "project") return element.sessions;
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "machine") return this.machineItem(node);
    if (node.kind === "project") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.description = String(node.sessions.length);
      item.tooltip = node.cwd;
      item.contextValue = "project";
      return item;
    }
    return this.sessionItem(node);
  }

  private machineItem(node: MachineNode): vscode.TreeItem {
    const m = node.machine;
    const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.Expanded);
    const enabled = m.isLocal || this.source.machineEnabled(m.id);
    item.description = enabled ? m.state : `${m.state} · disabled`;
    item.tooltip = m.error ? `${m.name}: ${m.error}` : m.name;
    item.iconPath =
      m.state === "error"
        ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"))
        : new vscode.ThemeIcon(m.isLocal ? "device-desktop" : "vm");
    item.contextValue = `machine:${m.isLocal ? "local" : "remote"}:${enabled ? "enabled" : "disabled"}:${m.state}`;
    return item;
  }

  private sessionItem(node: Extract<TreeNode, { kind: "session" }>): vscode.TreeItem {
    const { row } = node;
    const s = row.session;
    const now = Date.now();
    const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
    item.id = `${row.machineId}/${s.agent}:${s.id}`;
    item.description = sessionDescription(row, now);
    const icon = vscode.Uri.joinPath(this.resources, `${sessionIconName(row)}.svg`);
    item.iconPath = { light: icon, dark: icon };
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${s.title}**\n\n`);
    md.appendMarkdown(`- Agent: ${s.agent}\n- Status: ${s.status}${s.live ? ` (pid ${s.live.pid})` : ""}\n`);
    md.appendMarkdown(`- Folder: \`${s.cwd || "(no folder)"}\`\n- Id: \`${s.id}\`\n`);
    md.appendMarkdown(`- Created: ${new Date(s.createdAt).toLocaleString()}\n- Updated: ${new Date(s.updatedAt).toLocaleString()}\n`);
    item.tooltip = md;
    const isLocal = row.machineId === "local";
    item.contextValue = `session:${isLocal ? "local" : "remote"}:${s.agent}:${row.hidden ? "hidden" : "visible"}:${row.unread ? "unread" : "read"}`;
    item.command = { command: "agentSessions.openSession", title: "Open Session", arguments: [node] };
    return item;
  }
}
