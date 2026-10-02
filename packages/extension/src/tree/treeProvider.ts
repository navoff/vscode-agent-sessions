import { dirname } from "node:path";
import * as vscode from "vscode";
import { buildTree, projectContextValue, sessionContextValue, sessionDescription, sessionIconName, sessionTooltip, type MachineInput, type MachineNode, type TreeFilter, type TreeNode } from "./treeModel.js";
import type { SessionRow } from "../state/sessionStore.js";

export interface TreeSource {
  machines(): MachineInput[];
  rows(): Map<string, SessionRow[]>;
  filter(): TreeFilter;
  machineEnabled(machineId: string): boolean;
  isProjectHidden(machineId: string, cwd: string): boolean;
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tree: MachineNode[] = [];

  constructor(private readonly source: TreeSource, private readonly resources: vscode.Uri, private readonly home: string) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      this.tree = buildTree(this.source.machines(), this.source.rows(), this.source.filter(), { home: this.home, workspaceFolders: folders, currentProject: currentProject(folders), isProjectHidden: (m, cwd) => this.source.isProjectHidden(m, cwd) });
      return this.tree;
    }
    if (element.kind === "machine") return element.projects;
    if (element.kind === "project") return element.sessions;
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "machine") return this.machineItem(node);
    if (node.kind === "project") {
      const item = new vscode.TreeItem(node.label, node.sessions.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.iconPath = node.hidden ? new vscode.ThemeIcon("folder", new vscode.ThemeColor("disabledForeground")) : new vscode.ThemeIcon("folder");
      if (node.hidden) item.description = "hidden";
      item.tooltip = node.cwd;
      item.contextValue = projectContextValue(node);
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
    // Values from session files go through appendText so markdown in them is escaped.
    const tip = sessionTooltip(s, now);
    md.appendMarkdown("**");
    md.appendText(tip.title);
    md.appendMarkdown("**\n\n");
    if (tip.firstPrompt) {
      // Two spaces before a newline keep the prompt's line breaks without paragraph gaps.
      tip.firstPrompt.split("\n").forEach((line, i) => {
        if (i > 0) md.appendMarkdown("  \n");
        md.appendText(line);
      });
      md.appendMarkdown("\n\n");
    }
    md.appendMarkdown("Updated: ");
    md.appendText(tip.updated);
    item.tooltip = md;
    item.contextValue = sessionContextValue(row);
    item.command = { command: "agentSessions.clickSession", title: "Open Session", arguments: [node] };
    return item;
  }
}

// An untitled multi-root workspace has no folder of its own.
function currentProject(folders: string[]): string | undefined {
  const file = vscode.workspace.workspaceFile;
  if (file) return file.scheme === "untitled" ? undefined : dirname(file.fsPath);
  return folders.length === 1 ? folders[0] : undefined;
}
