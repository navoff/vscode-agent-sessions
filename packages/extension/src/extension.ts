import * as vscode from "vscode";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "@agent-sessions/core";
import { clearPendingOpen, PROTOCOL_VERSION, readPendingOpen } from "@agent-sessions/daemon";
import { daemonVersionAction, protocolMismatchAction } from "./connection/daemonUpgrade.js";
import { isProtocolMismatch, MachineConnection, type ProcessFactory } from "./connection/machineConnection.js";
import { connectLocalDaemon, localDaemonPaths } from "./connection/localConnection.js";
import { daemonBuildId, daemonFreshForMs, daemonProcessAlive, readDaemonPid, stopDaemonProcess } from "./connection/sharedDaemon.js";
import { spawnSshDaemon } from "./connection/sshConnection.js";
import { createSshRunner } from "./connection/sshRunner.js";
import { CODEX_EDITOR_VIEW_TYPE, openSession, registerSessionCommands, startNewSession, type CommandDeps, type FilterState } from "./commands.js";
import { claudeFindsSession, isNewSessionRequest, pendingSessionFor } from "./claudeFolder.js";
import { parseMachinesFileStrict, readMachinesFile, serializeMachinesFile, writeMachinesFile, type MachinesFile } from "./machines/machinesFile.js";
import { registerMachineCommands } from "./machines/machinesUi.js";
import { remoteDaemonPath } from "./machines/prepare.js";
import { SessionMarks } from "./state/marks.js";
import { SessionStore, type SessionRow } from "./state/sessionStore.js";
import { codexTabSessionId, pickViewed, tabCandidates, type AgentTab } from "./state/viewedSession.js";
import type { MachineInput } from "./tree/treeModel.js";
import { SessionsTreeProvider } from "./tree/treeProvider.js";

const LOCAL_ID = "local";
const FILTER_KEY = "agentSessions.filter";
const AUTO_RESTART_INTERVAL_MS = 60_000;
// VS Code prefixes the view type of a webview panel in its tab input.
const CLAUDE_PANEL_VIEW_TYPE = "claudeVSCodePanel";

// Injected by esbuild from packages/daemon/package.json; absent under tsc. The
// full daemon version adds a hash of the bundled daemon.mjs, see daemonBuildId.
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
  let bundledDaemonVersion: string | undefined;
  if (BUNDLED_DAEMON_VERSION !== undefined) {
    try {
      bundledDaemonVersion = `${BUNDLED_DAEMON_VERSION}+${await daemonBuildId(daemonPath)}`;
    } catch (err) {
      appendLog(`[${LOCAL_ID}] cannot hash ${daemonPath}: ${String(err)}`);
    }
  }
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

  const stored = context.workspaceState.get<Partial<FilterState>>(FILTER_KEY);
  let filter: FilterState = {
    agents: stored?.agents,
    showRemote: stored?.showRemote ?? true,
    workspaceOnly: stored?.workspaceOnly === true,
  };
  const updateFilterContext = () => {
    const active = filter.agents !== undefined || filter.workspaceOnly || !filter.showRemote;
    void vscode.commands.executeCommand("setContext", "agentSessions.filterActive", active);
  };
  updateFilterContext();
  // Drives the eye / eye-closed icon of the hidden-sessions toggle.
  const updateShowHiddenContext = () => {
    void vscode.commands.executeCommand("setContext", "agentSessions.showHidden", cfg().get<boolean>("showHidden", false));
  };
  updateShowHiddenContext();

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
      filter: () => ({ agents: filter.agents ? new Set<AgentKind>(filter.agents) : undefined, showRemote: filter.showRemote, workspaceOnly: filter.workspaceOnly, showHidden: cfg().get<boolean>("showHidden", false) }),
      machineEnabled: (id) => machines.machines.find((m) => m.id === id)?.enabled ?? true,
      isProjectHidden: (id, cwd) => store.isProjectHidden(id, cwd),
    },
    vscode.Uri.joinPath(context.extensionUri, "resources"),
    homedir(),
  );
  const treeView = vscode.window.createTreeView("agentSessions.view", { treeDataProvider: tree, showCollapseAll: true, canSelectMany: true });
  context.subscriptions.push(tree, treeView);
  const refresh = () => tree.refresh();

  // A session whose tab is in front of the user in this focused window is
  // being read, so activity that arrives meanwhile, or that the user comes
  // back to, does not leave it unread. Agent views outside the editor area
  // (the Claude Code and Codex sidebars) are not tabs and are not seen here.
  const activeAgentTab = (): AgentTab | undefined => {
    if (!vscode.window.state.focused) return undefined;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (input instanceof vscode.TabInputWebview && input.viewType.endsWith(CLAUDE_PANEL_VIEW_TYPE)) return { agent: "claude", label: tab?.label ?? "" };
    if (input instanceof vscode.TabInputCustom && input.viewType === CODEX_EDITOR_VIEW_TYPE && input.uri.scheme === "openai-codex") {
      const sessionId = codexTabSessionId(input.uri.path);
      if (sessionId) return { agent: "codex", sessionId };
    }
    return undefined;
  };
  const markViewedRead = async (): Promise<void> => {
    const tab = activeAgentTab();
    if (!tab) return;
    let candidates = tabCandidates(tab, store.rows(LOCAL_ID));
    if (!candidates.some((r) => r.unread)) return;
    if (tab.agent === "claude") {
      // Claude Code shows only sessions of the window folder; a session of the
      // same title elsewhere is not the one in the tab.
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const reachable: SessionRow[] = [];
      for (const r of candidates) if (await claudeFindsSession(r.session.cwd, folders)) reachable.push(r);
      candidates = reachable;
    }
    const viewed = pickViewed(candidates);
    if (!viewed?.unread) return;
    store.markRead(LOCAL_ID, viewed.session, Date.now());
    refresh();
  };
  const onViewChange = () => {
    markViewedRead().catch((err) => appendLog(`[${LOCAL_ID}] marking the viewed session read failed: ${String(err)}`));
  };
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(onViewChange),
    vscode.window.tabGroups.onDidChangeTabGroups(onViewChange),
    vscode.window.onDidChangeWindowState(onViewChange),
  );

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
          if (id === LOCAL_ID && state === "connected") checkLocalDaemonVersion(conn);
          if (state === "error" && isProtocolMismatch(error)) {
            if (id === LOCAL_ID) onLocalProtocolMismatch(conn, error);
            else onRemoteProtocolMismatch(id, error ?? "");
          }
        },
        onSessions: (sessions) => {
          store.setMachineSessions(id, sessions);
          refresh();
          if (id === LOCAL_ID) onViewChange();
        },
        onWarning: (message) => appendLog(`[${id}] ${message}`),
      },
      {
        autoReconnect: id === LOCAL_ID || (machines.machines.find((x) => x.id === id)?.autoConnect ?? false),
        // A remote daemon is replaced only by Prepare Machine; retrying cannot help.
        retryOnProtocolMismatch: id === LOCAL_ID,
      },
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

  // A shared daemon newer than this window was started by an updated window;
  // replacing it would only make the windows restart each other. Say so once.
  let newerDaemonWarned = false;
  const onNewerLocalDaemon = (what: string) => {
    appendLog(`[${LOCAL_ID}] local daemon is newer than this extension (${what}), leaving it running`);
    if (newerDaemonWarned) return;
    newerDaemonWarned = true;
    void vscode.window.showWarningMessage(`Agent Sessions: the running daemon is from a newer version of the extension (${what}). Reload this window or update the extension.`);
  };

  // Restarts the shared daemon when it is older than the bundled one (see
  // daemonVersionAction), unless it was started less than a minute ago (see
  // daemonFreshForMs); then checks again once that minute is over.
  let versionCheckTimer: ReturnType<typeof setTimeout> | undefined;
  const checkLocalDaemonVersion = (c: MachineConnection | undefined) => {
    const running = c?.daemonVersion;
    if (!c || bundledDaemonVersion === undefined || running === undefined) return;
    const action = daemonVersionAction(running, bundledDaemonVersion);
    if (action === "keep") return;
    if (action === "newer") {
      onNewerLocalDaemon(`${running}, bundled ${bundledDaemonVersion}`);
      return;
    }
    void daemonFreshForMs(localDaemonPaths().version, running, Date.now()).then((freshMs) => {
      if (connections.get(LOCAL_ID) !== c || c.state !== "connected" || c.daemonVersion !== running) return;
      if (freshMs > 0) {
        appendLog(`[${LOCAL_ID}] local daemon ${running} is older than bundled ${bundledDaemonVersion} but was just started, checking again in ${Math.ceil(freshMs / 1000)} s`);
        if (versionCheckTimer) clearTimeout(versionCheckTimer);
        versionCheckTimer = setTimeout(() => {
          versionCheckTimer = undefined;
          checkLocalDaemonVersion(c);
        }, freshMs + 100);
        return;
      }
      appendLog(`[${LOCAL_ID}] local daemon ${running} is older than bundled ${bundledDaemonVersion}, restarting`);
      void restartLocalDaemon(true);
    });
  };

  // A shared daemon that speaks another protocol never says hello, so the
  // version check above never runs. An older one (started by an older version
  // still running) is restarted the same way, with the same one-minute grace
  // for a daemon that some window has just started; the connection keeps
  // retrying meanwhile, and every failed attempt comes back here. A newer one
  // is left alone.
  const onLocalProtocolMismatch = (c: MachineConnection | undefined, error: string | undefined) => {
    if (!c) return;
    const action = protocolMismatchAction(error, PROTOCOL_VERSION);
    if (action === "newer") {
      onNewerLocalDaemon(error ?? "");
      return;
    }
    if (action !== "restart") {
      appendLog(`[${LOCAL_ID}] cannot tell the local daemon's protocol from "${error ?? ""}", leaving it running`);
      return;
    }
    if (versionCheckTimer || restarting) return;
    const versionFile = localDaemonPaths().version;
    void readFile(versionFile, "utf8")
      .then((t) => t.trim(), () => "")
      .then((running) => daemonFreshForMs(versionFile, running, Date.now()))
      .then((freshMs) => {
        if (connections.get(LOCAL_ID) !== c || c.state === "connected" || versionCheckTimer) return;
        if (freshMs > 0) {
          appendLog(`[${LOCAL_ID}] local daemon speaks an older protocol but was just started, restarting it in ${Math.ceil(freshMs / 1000)} s`);
          versionCheckTimer = setTimeout(() => {
            versionCheckTimer = undefined;
            if (connections.get(LOCAL_ID) === c && c.state !== "connected") void restartLocalDaemon(true);
          }, freshMs + 100);
          return;
        }
        appendLog(`[${LOCAL_ID}] local daemon speaks an older protocol, restarting`);
        void restartLocalDaemon(true);
      });
  };

  // A remote daemon from an older (or newer) extension: only Prepare Machine
  // replaces it, so offer that instead of retrying.
  const onRemoteProtocolMismatch = (id: string, error: string) => {
    const m = machines.machines.find((x) => x.id === id);
    if (!m) return;
    void vscode.window
      .showWarningMessage(`${m.name}: the daemon there is from another version of the extension (${error}). Run Prepare Machine to update it.`, "Prepare Machine")
      .then(async (pick) => {
        if (pick !== "Prepare Machine") return;
        const before = machines.machines.find((x) => x.id === id);
        await vscode.commands.executeCommand("agentSessions.prepareMachine", { kind: "machine", machine: { id, name: m.name, isLocal: false, state: "error" }, projects: [] });
        // A successful prepare saves a new record for the machine; a failed one has shown its error.
        const after = machines.machines.find((x) => x.id === id);
        if (after && after !== before) connect(id);
      });
  };

  // Asks the shared daemon to stop, kills it when it does not exit (a hung
  // daemon never answers "shutdown"), and reconnects, which starts a fresh
  // one. Automatic restarts (version mismatch) are limited to one per minute
  // per window.
  let lastAutoRestart = 0;
  let restarting = false;
  let disposed = false;
  const restartLocalDaemon = async (auto: boolean): Promise<void> => {
    if (restarting) return;
    if (auto && Date.now() - lastAutoRestart < AUTO_RESTART_INTERVAL_MS) {
      appendLog(`[${LOCAL_ID}] auto restart suppressed`);
      return;
    }
    if (auto) lastAutoRestart = Date.now();
    restarting = true;
    try {
      appendLog(`[${LOCAL_ID}] restarting local daemon`);
      const paths = localDaemonPaths();
      // Read before the shutdown: afterwards the file may already name a
      // successor started by another window.
      const pid = await readDaemonPid(paths.pid);
      const c = connections.get(LOCAL_ID);
      c?.requestShutdown();
      for (let i = 0; i < 20 && c && connections.get(LOCAL_ID) === c && c.state === "connected"; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = await stopDaemonProcess(paths, {
        pid,
        waitMs: 2000,
        kill: (p, signal) => process.kill(p, signal),
        isAlive: daemonProcessAlive,
      });
      if (result === "killed") appendLog(`[${LOCAL_ID}] local daemon ${pid} did not exit on SIGTERM, killed it`);
      if (disposed) return;
      dropConnection(LOCAL_ID);
      connect(LOCAL_ID);
    } catch (err) {
      appendLog(`[${LOCAL_ID}] restart failed: ${String(err)}`);
    } finally {
      restarting = false;
    }
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

  const sessionDeps: CommandDeps = {
    store,
    refresh,
    log,
    deleteSession: (machineId, agent, id) => {
      const c = connections.get(machineId);
      return c ? c.deleteSession(agent, id) : Promise.reject(new Error("the machine is not connected"));
    },
    selection: () => treeView.selection,
    getFilter: () => filter,
    setFilter: (f) => {
      filter = f;
      updateFilterContext();
      void context.workspaceState.update(FILTER_KEY, f);
    },
    pendingOpen: (machineId, session) => {
      const c = connections.get(machineId);
      return c ? c.pendingOpen(session) : Promise.reject(new Error("the machine is not connected"));
    },
    sshHost: (machineId) => machines.machines.find((m) => m.id === machineId)?.sshHost,
  };
  registerSessionCommands(context, sessionDeps);

  // A session, or a request for a new one, that another window handed over to
  // a window on its folder, through the pending-open file of this machine (see
  // daemon/pendingOpen.ts): this window, when it has just been opened or, if
  // it already existed, focused.
  const openPendingSession = async () => {
    const pending = await readPendingOpen(homedir());
    if (!pending) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const session = await pendingSessionFor(pending, folders, Date.now());
    if (!session) return;
    await clearPendingOpen(homedir());
    if (isNewSessionRequest(session)) await startNewSession(session.agent);
    else await openSession(sessionDeps, LOCAL_ID, session);
  };
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => { if (s.focused) void openPendingSession(); }));
  void openPendingSession();

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
      if (e.affectsConfiguration("agentSessions")) {
        updateShowHiddenContext();
        refresh();
      }
    }),
    { dispose: () => { disposed = true; if (reloadTimer) clearTimeout(reloadTimer); if (versionCheckTimer) clearTimeout(versionCheckTimer); machinesWatcher?.close(); for (const c of connections.values()) c.dispose(); } },
    log,
  );

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  watchMachinesFile();

  // Demo mode (scripts/demo-data.mjs, "Run Extension (demo data)"): bring the
  // view up so a screenshot needs no clicks.
  if (process.env.AGENT_SESSIONS_DEMO === "1") {
    void vscode.commands.executeCommand("workbench.view.extension.agentSessionsPanel");
  }
  if (cfg().get<boolean>("autoConnectOnStartup", true)) {
    connect(LOCAL_ID);
    for (const m of machines.machines) if (m.enabled && m.autoConnect) connect(m.id);
  }
}

export function deactivate(): void {}
