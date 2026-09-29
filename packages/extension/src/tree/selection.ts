import type { SessionNode, TreeNode } from "./treeModel.js";

/**
 * Session nodes a context-menu command should act on. VS Code passes the
 * clicked node first and, when the tree allows multi-select, the whole
 * selection second. The selection counts only when it contains the clicked
 * node; otherwise the command applies to the clicked node alone.
 */
export function selectionTargets(node: TreeNode | undefined, selected: readonly TreeNode[] | undefined): SessionNode[] {
  if (!node || node.kind !== "session") return [];
  const useSelection = Array.isArray(selected) && selected.includes(node);
  const nodes = useSelection ? selected : [node];
  const seen = new Set<string>();
  const out: SessionNode[] = [];
  for (const n of nodes) {
    if (n.kind !== "session") continue;
    const key = `${n.machineId}/${n.row.session.agent}:${n.row.session.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}
