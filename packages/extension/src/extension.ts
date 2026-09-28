import * as vscode from "vscode";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "@agent-sessions/core";
import { MachineConnection, type ProcessFactory } from "./connection/machineConnection.js";
import { spawnLocalDaemon } from "./connection/localConnection.js";
import { spawnSshDaemon } from "./connection/sshConnection.js";
import { createSshRunner } from "./connection/sshRunner.js";
import { registerSessionCommands, type FilterState } from "./commands.js";
import { parseMachinesFile, readMachinesFile, serializeMachinesFile, writeMachinesFile, type MachinesFile } from "./machines/machinesFile.js";
import { registerMachineCommands } from "./machines/machinesUi.js";
import { remoteDaemonPath } from "./machines/prepare.js";
import { SessionMarks } from "./state/marks.js";
import { SessionStore, type SessionRow } from "./state/sessionStore.js";
import type { MachineInput } from "./tree/treeModel.js";
import { SessionsTreeProvider } from "./tree/treeProvider.js";

const LOCAL_ID = "local";
const FILTER_KEY = "agentSessions.filter";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Agent Sessions");
  context.subscriptions.push(log);
  const appendLog = (line: string) => log.appendLine(line);

  const store = new SessionStore(new SessionMarks(context.globalState));
  const connections = new Map<string, MachineConnection>();
  const daemonPath = context.asAbsolutePath("dist/daemon.mjs");
  const machinesPath = join(context.globalStorageUri.fsPath, "machines.json");
  let machines: MachinesFile = await readMachinesFile(machinesPath);
  let lastMachinesText: string | undefined = serializeMachinesFile(machines);

  const cfg = () => vscode.workspace.getConfiguration("agentSessions");
  const sshPath = () => cfg().get<string>("ssh.path", "ssh");

  let filter: FilterState = context.workspaceState.get<FilterState>(FILTER_KEY) ?? { agents: undefined, showRemote: true };

  const tree = new SessionsTreeProvider(
    {
      machines: (): MachineInput[] => {
        const local = connections.get(LOCAL_ID);
        const list: MachineInput[] = [{ id: LOCAL_ID, name: "This machine", isLocal: true, state: local?.state ?? "disconnected", error: local?.error }];
        for (const m of machines.machines) {
          const c = connections.get(m.id);
          list.push({ id: m.id, name: m.name, isLocal: false, state: c?.state ?? "disconnected", error: c?.error, home: c?.home ?? m.remoteHome });
        }
        return list;
      },
      rows: () => new Map<string, SessionRow[]>(store.machineIds().map((id) => [id, store.rows(id)])),
      filter: () => ({ agents: filter.agents ? new Set<AgentKind>(filter.agents) : undefined, showRemote: filter.showRemote, showHidden: cfg().get<boolean>("showHidden", false) }),
      machineEnabled: (id) => machines.machines.find((m) => m.id === id)?.enabled ?? true,
    },
    vscode.Uri.joinPath(context.extensionUri, "resources"),
    homedir(),
  );
  context.subscriptions.push(tree, vscode.window.createTreeView("agentSessions.view", { treeDataProvider: tree, showCollapseAll: true }));
  const refresh = () => tree.refresh();

  const makeConnection = (id: string): MachineConnection | undefined => {
    const existing = connections.get(id);
    if (existing) return existing;
    let factory: ProcessFactory;
    if (id === LOCAL_ID) {
      factory = () => spawnLocalDaemon(daemonPath, appendLog);
    } else {
      if (!machines.machines.some((x) => x.id === id)) return undefined;
      factory = () => {
        const m = machines.machines.find((x) => x.id === id);
        if (!m) throw new Error("machine removed");
        if (!m.remoteNode || !m.remoteHome) throw new Error("machine is not prepared, run Prepare Machine");
        return spawnSshDaemon(sshPath(), m.sshHost, m.remoteNode, remoteDaemonPath(m.remoteHome), appendLog);
      };
    }
    const conn = new MachineConnection(
      id,
      factory,
      {
        onStateChange: (state, error) => {
          appendLog(`[${id}] ${state}${error ? `: ${error}` : ""}`);
          refresh();
        },
        onSessions: (sessions) => {
          store.setMachineSessions(id, sessions);
          refresh();
        },
      },
      { autoReconnect: id === LOCAL_ID || (machines.machines.find((x) => x.id === id)?.autoConnect ?? false) },
    );
    connections.set(id, conn);
    return conn;
  };

  const connect = (id: string) => {
    const m = machines.machines.find((x) => x.id === id);
    if (id !== LOCAL_ID && m && !m.enabled) {
      void vscode.window.showWarningMessage(`${m.name} is disabled.`);
      return;
    }
    makeConnection(id)?.connect();
  };
  const dropConnection = (id: string) => {
    connections.get(id)?.dispose();
    connections.delete(id);
    store.removeMachine(id);
  };
  const disconnect = (id: string) => {
    dropConnection(id);
    refresh();
  };

  const reloadMachinesOnce = async () => {
    let text: string;
    try {
      text = await readFile(machinesPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      text = "";
    }
    if (text === lastMachinesText) return;
    if (text) {
      try {
        JSON.parse(text);
      } catch {
        appendLog(`[machines] ${machinesPath} is not valid JSON, keeping the previous list`);
        return;
      }
    }
    machines = text ? parseMachinesFile(text) : { version: 1, machines: [] };
    lastMachinesText = text;
    for (const id of [...connections.keys()]) {
      if (id === LOCAL_ID) continue;
      const m = machines.machines.find((x) => x.id === id);
      if (!m || !m.enabled) dropConnection(id);
    }
    refresh();
  };

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloading = false;
  let reloadPending = false;
  const reloadMachines = async (): Promise<void> => {
    if (reloading) {
      reloadPending = true;
      return;
    }
    reloading = true;
    try {
      do {
        reloadPending = false;
        await reloadMachinesOnce();
      } while (reloadPending);
    } finally {
      reloading = false;
    }
  };
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      reloadMachines().catch((err) => appendLog(`[machines] reload failed: ${String(err)}`));
    }, 200);
  };

  let machinesWatcher: FSWatcher | undefined;
  const watchMachinesFile = () => {
    machinesWatcher?.close();
    try {
      machinesWatcher = watch(join(context.globalStorageUri.fsPath), (_e, name) => {
        if (name === "machines.json") scheduleReload();
      });
    } catch {
      machinesWatcher = undefined;
    }
  };

  registerSessionCommands(context, {
    store,
    refresh,
    log,
    getFilter: () => filter,
    setFilter: (f) => {
      filter = f;
      void context.workspaceState.update(FILTER_KEY, f);
    },
  });

  registerMachineCommands(context, {
    current: () => machines,
    save: async (f) => {
      machines = f;
      lastMachinesText = serializeMachinesFile(f);
      await writeMachinesFile(machinesPath, f);
      watchMachinesFile();
      refresh();
    },
    sshRunner: () => createSshRunner(sshPath(), appendLog),
    daemonSource: () => readFile(daemonPath, "utf8"),
    connect,
    disconnect,
    log,
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentSessions")) refresh();
    }),
    { dispose: () => { if (reloadTimer) clearTimeout(reloadTimer); machinesWatcher?.close(); for (const c of connections.values()) c.dispose(); } },
  );

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  watchMachinesFile();

  if (cfg().get<boolean>("autoConnectOnStartup", true)) {
    connect(LOCAL_ID);
    for (const m of machines.machines) if (m.enabled && m.autoConnect) connect(m.id);
  }
}

export function deactivate(): void {}
