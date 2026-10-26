import * as vscode from "vscode";
import { parseAgentSessionsUri, type UriRequest } from "./uriRequest.js";

export { parseAgentSessionsUri, type UriRequest };

export interface UriHandlerDeps {
  /** Opens the session; rejects or shows its own message when it cannot. */
  openSession(machineId: string, agent: string, id: string): Promise<void>;
  /** Marks the session read without opening it; a session not in the list is a no-op. */
  markRead(machineId: string, agent: string, id: string): void;
  /** Marks every session that waits for the user read. */
  markAllRead(): void;
  log(line: string): void;
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
        switch (req.kind) {
          case "show":
            void vscode.commands.executeCommand("agentSessions.view.focus");
            return;
          case "readAll":
            deps.markAllRead();
            return;
          case "read":
            deps.markRead(req.machineId, req.agent, req.id);
            return;
          case "open":
            deps.openSession(req.machineId, req.agent, req.id).catch((err) => deps.log(`[uri] opening ${req.agent}:${req.id} failed: ${String(err)}`));
        }
      },
    }),
  );
}
