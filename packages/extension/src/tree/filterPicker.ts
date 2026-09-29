import type { AgentKind } from "@agent-sessions/core";

export interface FilterState {
  agents: AgentKind[] | undefined;
  showRemote: boolean;
  workspaceOnly: boolean;
}

export type FilterPickId = "agent:claude" | "agent:codex" | "agent:opencode" | "workspaceOnly" | "showRemote";

export type FilterPickItem =
  | { kind: "separator"; label: string }
  | { kind: "item"; id: FilterPickId; label: string; description?: string; picked: boolean };

const ALL_AGENTS: AgentKind[] = ["claude", "codex", "opencode"];

export function buildFilterItems(state: FilterState, hasWorkspace: boolean): FilterPickItem[] {
  const items: FilterPickItem[] = [{ kind: "separator", label: "Agents" }];
  for (const a of ALL_AGENTS) {
    items.push({ kind: "item", id: `agent:${a}`, label: a, picked: !state.agents || state.agents.includes(a) });
  }
  items.push({ kind: "separator", label: "Projects" });
  items.push({
    kind: "item",
    id: "workspaceOnly",
    label: "Only the workspace open in this window",
    ...(hasWorkspace ? {} : { description: "(no folder open)" }),
    picked: state.workspaceOnly,
  });
  items.push({ kind: "separator", label: "Remote machines" });
  items.push({ kind: "item", id: "showRemote", label: "Show remote machines", picked: state.showRemote });
  return items;
}

export function applyFilterPicks(pickedIds: string[]): FilterState {
  const set = new Set(pickedIds);
  const agents = ALL_AGENTS.filter((a) => set.has(`agent:${a}`));
  return {
    agents: agents.length === 0 || agents.length === ALL_AGENTS.length ? undefined : agents,
    workspaceOnly: set.has("workspaceOnly"),
    showRemote: set.has("showRemote"),
  };
}
