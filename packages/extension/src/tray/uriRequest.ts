export type UriRequest = { kind: "open" | "read"; machineId: string; agent: string; id: string } | { kind: "show" | "readAll" };

/**
 * The requests the tray helper sends through `<scheme>://navoff.vscode-agent-sessions/...`:
 * `/open?s=<base64url of {"machine","agent","id"} JSON>` opens a session, `/read?s=...`
 * marks it read without opening it, `/read-all` marks every waiting session read, `/show`
 * focuses the view. The session travels as base64url because its characters
 * mean the same however many times the query is percent-decoded on the way
 * (vscode.Uri.query is decoded already, URLSearchParams decodes again).
 */
export function parseAgentSessionsUri(path: string, query: string): UriRequest | undefined {
  if (path === "/show") return { kind: "show" };
  if (path === "/read-all") return { kind: "readAll" };
  if (path !== "/open" && path !== "/read") return undefined;
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
  return { kind: path === "/open" ? "open" : "read", machineId: machine, agent, id };
}

/**
 * A click the tray helper hands back over its socket, one JSON line (Action
 * in the helper's protocol.go): `{"type":"open"|"read","session":{"machine","agent","id"}}`,
 * `{"type":"readAll"}` or `{"type":"show"}`; the same requests as the URIs above.
 */
export function parseTrayAction(line: string): UriRequest | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof msg !== "object" || msg === null) return undefined;
  const { type, session } = msg as Record<string, unknown>;
  if (type === "show" || type === "readAll") return { kind: type };
  if (type !== "open" && type !== "read") return undefined;
  if (typeof session !== "object" || session === null) return undefined;
  const { machine, agent, id } = session as Record<string, unknown>;
  if (typeof machine !== "string" || typeof agent !== "string" || typeof id !== "string" || !machine || !agent || !id) return undefined;
  return { kind: type, machineId: machine, agent, id };
}
