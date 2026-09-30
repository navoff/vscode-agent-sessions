import type { SessionRow } from "./sessionStore.js";

/**
 * The tab of an agent extension that is in front of the user. A Codex tab
 * names its session in its URI; a Claude Code tab is a webview that shows
 * only a label made of the session title.
 */
export type AgentTab = { agent: "claude"; label: string } | { agent: "codex"; sessionId: string };

/** The label Claude Code gives the tab of a session with this title. */
export function claudeTabLabel(title: string): string {
  return title.length > 25 ? title.substring(0, 24) + "…" : title;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The thread id in the path of a Codex conversation URI, `/local/<id>`. */
export function codexTabSessionId(path: string): string | undefined {
  return /^\/local\/([^/]+)$/.exec(path)?.[1];
}

/** The sessions that `tab` may be showing. */
export function tabCandidates(tab: AgentTab, rows: readonly SessionRow[]): SessionRow[] {
  if (tab.agent === "codex") return rows.filter((r) => r.session.agent === "codex" && r.session.id === tab.sessionId);
  const label = squash(tab.label);
  return rows.filter((r) => r.session.agent === "claude" && squash(claudeTabLabel(r.session.title)) === label);
}

/**
 * The session a tab shows, out of its candidates. Several sessions of one
 * label are told apart by a live process, which an open tab has once it has
 * worked; when that does not single one out, none is picked.
 */
export function pickViewed(candidates: readonly SessionRow[]): SessionRow | undefined {
  if (candidates.length === 1) return candidates[0];
  const live = candidates.filter((r) => r.session.live !== undefined);
  return live.length === 1 ? live[0] : undefined;
}
