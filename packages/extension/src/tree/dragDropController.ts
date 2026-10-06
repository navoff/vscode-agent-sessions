import * as vscode from "vscode";
import { planDrop, type DropPlan } from "./dragDrop.js";
import type { TreeNode } from "./treeModel.js";

/** The mime type VS Code gives items dragged within the view agentSessions.view. */
const TREE_MIME = "application/vnd.code.tree.agentsessions.view";

/** Dragging sessions onto a folder of the tree moves them to that folder. */
export class SessionsDragAndDrop implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dragMimeTypes = [TREE_MIME];
  readonly dropMimeTypes = [TREE_MIME];

  constructor(private readonly onDrop: (plan: Extract<DropPlan, { ok: true }>) => unknown) {}

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const sessions = source.filter((n) => n.kind === "session");
    if (sessions.length > 0) dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(sessions));
  }

  handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): void {
    const dragged = dataTransfer.get(TREE_MIME)?.value as readonly TreeNode[] | undefined;
    if (!Array.isArray(dragged)) return;
    const plan = planDrop(dragged, target);
    if (plan.ok) void this.onDrop(plan);
    else if (plan.reason) void vscode.window.showWarningMessage(plan.reason);
  }
}
