import * as vscode from "vscode";
import { parseAgentSessionsUri, type UriRequest } from "./uriRequest.js";

export { parseAgentSessionsUri, type UriRequest };

export interface UriHandlerDeps {
  /** Opens the session; rejects or shows its own message when it cannot. */
  openSession(machineId: string, agent: string, id: string): Promise<void>;
  /** Marks the session read without opening it; a session not in the list is a no-op. */
  markRead(machineId: string, agent: string, id: string): Promise<void>;
  /** Marks every session that waits for the user read. */
  markAllRead(): void;
  /** Brings the window and its sessions view to the front. */
  show(): Promise<void>;
  log(line: string): void;
}

/** Does what a vscode:// URI or a click the tray helper hands back asks for. */
export function handleRequest(req: UriRequest, deps: UriHandlerDeps): void {
  switch (req.kind) {
    case "show":
      deps.show().catch((err) => deps.log(`[uri] showing the view failed: ${String(err)}`));
      return;
    case "readAll":
      deps.markAllRead();
      return;
    case "read":
      deps.markRead(req.machineId, req.agent, req.id).catch((err) => deps.log(`[uri] marking ${req.agent}:${req.id} read failed: ${String(err)}`));
      return;
    case "open":
      deps.openSession(req.machineId, req.agent, req.id).catch((err) => deps.log(`[uri] opening ${req.agent}:${req.id} failed: ${String(err)}`));
  }
}

export function registerUriHandler(context: vscode.ExtensionContext, deps: UriHandlerDeps): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        const req = parseAgentSessionsUri(uri.path, uri.query);
        if (!req) {
          deps.log(`[uri] ignoring ${uri.toString()}`);
          return;
        }
        handleRequest(req, deps);
      },
    }),
  );
}
