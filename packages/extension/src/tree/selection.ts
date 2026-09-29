import type { SessionNode, TreeNode } from "./treeModel.js";

/**
 * Session nodes a context-menu command should act on. VS Code passes the
 * clicked node first and, when the tree allows multi-select, the whole
 * selection second. The selection counts only when it contains the clicked
 * node; otherwise the command applies to the clicked node alone. A keybinding
 * passes no node, so the command applies to the whole selection. A folder
 * stands for the sessions shown under it; machines are ignored.
 */
export function selectionTargets(node: TreeNode | undefined, selected: readonly TreeNode[] | undefined): SessionNode[] {
  let nodes: readonly TreeNode[];
  if (!node) nodes = selected ?? [];
  else if (node.kind === "machine") return [];
  else nodes = Array.isArray(selected) && selected.includes(node) ? selected : [node];
  const seen = new Set<string>();
  const out: SessionNode[] = [];
  const add = (n: SessionNode) => {
    const key = `${n.machineId}/${n.row.session.agent}:${n.row.session.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  for (const n of nodes) {
    if (n.kind === "session") add(n);
    else if (n.kind === "project") n.sessions.forEach(add);
  }
  return out;
}
