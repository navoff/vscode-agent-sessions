export type UriRequest = { kind: "open"; machineId: string; agent: string; id: string } | { kind: "show" };

/**
 * The requests the tray helper sends through `<scheme>://navoff.vscode-agent-sessions/...`:
 * `/open?s=<base64url of {"machine","agent","id"} JSON>` opens a session, `/show`
 * focuses the view. The session travels as base64url because its characters
 * mean the same however many times the query is percent-decoded on the way
 * (vscode.Uri.query is decoded already, URLSearchParams decodes again).
 */
export function parseAgentSessionsUri(path: string, query: string): UriRequest | undefined {
  if (path === "/show") return { kind: "show" };
  if (path !== "/open") return undefined;
  const s = new URLSearchParams(query).get("s");
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const { machine, agent, id } = payload as Record<string, unknown>;
  if (typeof machine !== "string" || typeof agent !== "string" || typeof id !== "string" || !machine || !agent || !id) return undefined;
  return { kind: "open", machineId: machine, agent, id };
}
