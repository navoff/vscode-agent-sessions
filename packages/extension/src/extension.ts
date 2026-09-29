import * as vscode from "vscode";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "@agent-sessions/core";
import { MachineConnection, type ProcessFactory } from "./connection/machineConnection.js";
import { connectLocalDaemon } from "./connection/localConnection.js";
import { spawnSshDaemon } from "./connection/sshConnection.js";
import { createSshRunner } from "./connection/sshRunner.js";
import { registerSessionCommands, type FilterState } from "./commands.js";
import { parseMachinesFileStrict, readMachinesFile, serializeMachinesFile, writeMachinesFile, type MachinesFile } from "./machines/machinesFile.js";
import { registerMachineCommands } from "./machines/machinesUi.js";
import { remoteDaemonPath } from "./machines/prepare.js";
import { SessionMarks } from "./state/marks.js";
import { SessionStore, type SessionRow } from "./state/sessionStore.js";
import type { MachineInput } from "./tree/treeModel.js";
import { SessionsTreeProvider } from "./tree/treeProvider.js";

const LOCAL_ID = "local";
const FILTER_KEY = "agentSessions.filter";
const AUTO_RESTART_INTERVAL_MS = 60_000;

// Injected by esbuild from packages/daemon/package.json; absent under tsc.
declare const __DAEMON_VERSION__: string | undefined;
const BUNDLED_DAEMON_VERSION = typeof __DAEMON_VERSION__ === "string" ? __DAEMON_VERSION__ : undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Agent Sessions");
  // The channel is registered for disposal at the end of activate(), after the
  // connections, so that shutdown log lines never hit a disposed channel.
  const appendLog = (line: string) => {
    try {
      log.appendLine(line);
    } catch {
      // channel already disposed during deactivation
    }
  };

  const store = new SessionStore(new SessionMarks(context.globalState));
  const connections = new Map<string, MachineConnection>();
  const daemonPath = context.asAbsolutePath("dist/daemon.mjs");
  const machinesPath = join(context.globalStorageUri.fsPath, "machines.json");
  const loadedMachines = await readMachinesFile(machinesPath);
  let machines: MachinesFile = loadedMachines ?? { version: 1, machines: [] };
  let lastMachinesText: string | undefined = loadedMachines ? serializeMachinesFile(machines) : undefined;
  // While set, machines.json on disk is invalid and must not be overwritten.
  let machinesFileBroken = loadedMachines === undefined;
  const brokenMessage = "machines.json is invalid, fix it by hand; machine commands are disabled until then";
  if (machinesFileBroken) {
    appendLog(`[machines] ${machinesPath} is not valid, not reading or writing it until it is fixed`);
    void vscode.window.showWarningMessage(brokenMessage);
  }

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
      factory = () => connectLocalDaemon(daemonPath, appendLog);
    } else {
      if (!machines.machines.some((x) => x.id === id)) return undefined;
      factory = () => {
        const m = machines.machines.find((x) => x.id === id);
        if (!m) throw new Error("machine removed");
        if (!m.remoteNode || !m.remoteHome) throw new Error("machine is not prepared, run Prepare Machine");
        return spawnSshDaemon(sshPath(), m.sshHost, m.remoteNode, remoteDaemonPath(m.remoteHome), appendLog);
      };
    }
    // Assigned right after construction; the callback reads it later.
    let conn: MachineConnection | undefined = undefined;
    conn = new MachineConnection(
      id,
      factory,
      {
        onStateChange: (state, error) => {
          appendLog(`[${id}] ${state}${error ? `: ${error}` : ""}`);
          refresh();
          if (id === LOCAL_ID && state === "connected") {
            const running = conn?.daemonVersion;
            if (BUNDLED_DAEMON_VERSION !== undefined && running !== undefined && running !== BUNDLED_DAEMON_VERSION) {
              appendLog(`[${id}] local daemon ${running} differs from bundled ${BUNDLED_DAEMON_VERSION}, restarting`);
              restartLocalDaemon(true);
            }
          }
        },
        onSessions: (sessions) => {
          store.setMachineSessions(id, sessions);
          refresh();
        },
        onWarning: (message) => appendLog(`[${id}] ${message}`),
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

  // Asks the shared daemon to stop and reconnects, which starts a fresh one.
  // Automatic restarts (version mismatch) are limited to one per minute so
  // two windows with different bundled versions cannot restart it in a loop.
  let lastAutoRestart = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  const restartLocalDaemon = (auto: boolean) => {
    if (auto && Date.now() - lastAutoRestart < AUTO_RESTART_INTERVAL_MS) {
      appendLog(`[${LOCAL_ID}] auto restart suppressed`);
      return;
    }
    if (auto) lastAutoRestart = Date.now();
    appendLog(`[${LOCAL_ID}] restarting local daemon`);
    connections.get(LOCAL_ID)?.requestShutdown();
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      dropConnection(LOCAL_ID);
      connect(LOCAL_ID);
    }, 500);
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
    const parsed = text.trim() ? parseMachinesFileStrict(text) : { version: 1 as const, machines: [] };
    if (!parsed) {
      appendLog(`[machines] ${machinesPath} is not valid, keeping the previous list`);
      return;
    }
    machines = parsed;
    lastMachinesText = text;
    if (machinesFileBroken) {
      machinesFileBroken = false;
      appendLog(`[machines] ${machinesPath} is valid again`);
    }
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
      if (machinesFileBroken) {
        void vscode.window.showErrorMessage(brokenMessage);
        throw new Error(brokenMessage);
      }
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
    vscode.commands.registerCommand("agentSessions.restartLocalDaemon", () => restartLocalDaemon(false)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentSessions")) refresh();
    }),
    { dispose: () => { if (reloadTimer) clearTimeout(reloadTimer); if (restartTimer) clearTimeout(restartTimer); machinesWatcher?.close(); for (const c of connections.values()) c.dispose(); } },
    log,
  );

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  watchMachinesFile();

  if (cfg().get<boolean>("autoConnectOnStartup", true)) {
    connect(LOCAL_ID);
    for (const m of machines.machines) if (m.enabled && m.autoConnect) connect(m.id);
  }
}

export function deactivate(): void {}
