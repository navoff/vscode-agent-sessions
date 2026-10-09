import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentSessionsUri } from "../tray/uriRequest.js";

const payload = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// What the tray helper's sessionURI builds for {machine: "my box", agent: "claude", id: "a&b"}
// (Go's encoder writes "&" as "\u0026").
const GO_URI = "vscode://navoff.vscode-agent-sessions/open?s=eyJtYWNoaW5lIjoibXkgYm94IiwiYWdlbnQiOiJjbGF1ZGUiLCJpZCI6ImFcdTAwMjZiIn0";

test("parses /open with the session in one base64url parameter", () => {
  assert.deepEqual(parseAgentSessionsUri("/open", `s=${payload({ machine: "my box", agent: "claude", id: "abc-123" })}`), { kind: "open", machineId: "my box", agent: "claude", id: "abc-123" });
});

test("parses a URI built by the tray helper, also after decoding it twice", () => {
  const url = new URL(GO_URI);
  const want = { kind: "open", machineId: "my box", agent: "claude", id: "a&b" };
  assert.deepEqual(parseAgentSessionsUri(url.pathname, url.search.slice(1)), want);
  // vscode.Uri.query is already percent-decoded; the parser decodes once more.
  assert.deepEqual(parseAgentSessionsUri(url.pathname, decodeURIComponent(url.search.slice(1))), want);
});

test("parses /show", () => {
  assert.deepEqual(parseAgentSessionsUri("/show", ""), { kind: "show" });
  assert.deepEqual(parseAgentSessionsUri("/show", "x=1"), { kind: "show" });
});

test("rejects other paths, the old parameters and bad payloads", () => {
  assert.equal(parseAgentSessionsUri("/", ""), undefined);
  assert.equal(parseAgentSessionsUri("/delete", `s=${payload({ machine: "local", agent: "claude", id: "a" })}`), undefined);
  assert.equal(parseAgentSessionsUri("/open", "machine=local&agent=claude&id=a"), undefined);
  assert.equal(parseAgentSessionsUri("/open", ""), undefined);
  assert.equal(parseAgentSessionsUri("/open", "s="), undefined);
  assert.equal(parseAgentSessionsUri("/open", "s=not*base64"), undefined);
  assert.equal(parseAgentSessionsUri("/open", `s=${Buffer.from("not json").toString("base64url")}`), undefined);
  assert.equal(parseAgentSessionsUri("/open", `s=${payload(["local", "claude", "a"])}`), undefined);
  assert.equal(parseAgentSessionsUri("/open", `s=${payload({ machine: "local", agent: "claude" })}`), undefined);
  assert.equal(parseAgentSessionsUri("/open", `s=${payload({ machine: "", agent: "claude", id: "a" })}`), undefined);
  assert.equal(parseAgentSessionsUri("/open", `s=${payload({ machine: "local", agent: "claude", id: 7 })}`), undefined);
});
