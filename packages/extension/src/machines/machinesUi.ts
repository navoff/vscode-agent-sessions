import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { addMachine, removeMachine, updateMachine, type MachineRecord, type MachinesFile } from "./machinesFile.js";
import { parseSshConfigHosts } from "./sshConfig.js";
import { prepareMachine, type SshRunner } from "./prepare.js";
import type { TreeNode } from "../tree/treeModel.js";

export interface MachinesUiDeps {
  current(): MachinesFile;
  save(f: MachinesFile): Promise<void>;
  sshRunner(): SshRunner;
  daemonSource(): Promise<string>;
  connect(id: string): void;
  disconnect(id: string): void;
  log: vscode.OutputChannel;
}

function machineOf(node: TreeNode | undefined): string | undefined {
  return node?.kind === "machine" && !node.machine.isLocal ? node.machine.id : undefined;
}

async function pickMachine(deps: MachinesUiDeps, node: TreeNode | undefined, title: string): Promise<MachineRecord | undefined> {
  const id = machineOf(node);
  const list = deps.current().machines;
  if (id) return list.find((m) => m.id === id);
  const pick = await vscode.window.showQuickPick(list.map((m) => ({ label: m.name, description: m.sshHost, id: m.id })), { title });
  return pick ? list.find((m) => m.id === pick.id) : undefined;
}

export async function runPrepare(deps: MachinesUiDeps, machine: MachineRecord): Promise<boolean> {
  try {
    const source = await deps.daemonSource();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Preparing ${machine.name}`, cancellable: false },
      (progress) => prepareMachine(machine.sshHost, deps.sshRunner(), source, (step) => progress.report({ message: step })),
    );
    await deps.save(updateMachine(deps.current(), machine.id, { remoteNode: result.remoteNode, daemonVersion: result.daemonVersion, remoteHome: result.remoteHome }));
    void vscode.window.showInformationMessage(`${machine.name}: daemon ${result.daemonVersion} ready.`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log.appendLine(`[prepare ${machine.name}] ${msg}`);
    void vscode.window.showErrorMessage(`Prepare ${machine.name} failed: ${msg}`, "Show Log").then((p) => p && deps.log.show());
    return false;
  }
}

export function registerMachineCommands(context: vscode.ExtensionContext, deps: MachinesUiDeps): void {
  const reg = (id: string, fn: (node?: TreeNode) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (node?: TreeNode) => fn(node)));

  reg("agentSessions.addMachine", async () => {
    let hosts: string[] = [];
    try {
      hosts = parseSshConfigHosts(await readFile(join(homedir(), ".ssh", "config"), "utf8"));
    } catch {
      // no ssh config
    }
    const known = new Set(deps.current().machines.map((m) => m.sshHost));
    const items = hosts.filter((h) => !known.has(h)).map((h) => ({ label: h, host: h }));
    const manual = { label: "$(edit) Enter host manually…", host: "" };
    const pick = await vscode.window.showQuickPick([...items, manual], { title: "Add machine from ~/.ssh/config" });
    if (!pick) return;
    let host = pick.host;
    if (!host) {
      host = (await vscode.window.showInputBox({ title: "SSH host", prompt: "Host name as used by ssh", validateInput: (v) => (v.trim() ? undefined : "Required") }))?.trim() ?? "";
      if (!host) return;
    }
    const file = addMachine(deps.current(), host);
    await deps.save(file);
    const machine = file.machines[file.machines.length - 1];
    if (await runPrepare(deps, machine)) deps.connect(machine.id);
  });

  reg("agentSessions.renameMachine", async (node) => {
    const m = await pickMachine(deps, node, "Rename machine");
    if (!m) return;
    const name = await vscode.window.showInputBox({ title: "New name", value: m.name });
    if (!name?.trim()) return;
    await deps.save(updateMachine(deps.current(), m.id, { name: name.trim() }));
  });

  reg("agentSessions.removeMachine", async (node) => {
    const m = await pickMachine(deps, node, "Remove machine");
    if (!m) return;
    const ok = await vscode.window.showWarningMessage(`Remove ${m.name} from the list? Files on the remote machine stay in place.`, { modal: true }, "Remove");
    if (ok !== "Remove") return;
    deps.disconnect(m.id);
    await deps.save(removeMachine(deps.current(), m.id));
  });

  reg("agentSessions.enableMachine", async (node) => {
    const m = await pickMachine(deps, node, "Enable machine");
    if (m) await deps.save(updateMachine(deps.current(), m.id, { enabled: true }));
  });

  reg("agentSessions.disableMachine", async (node) => {
    const m = await pickMachine(deps, node, "Disable machine");
    if (!m) return;
    deps.disconnect(m.id);
    await deps.save(updateMachine(deps.current(), m.id, { enabled: false }));
  });

  reg("agentSessions.prepareMachine", async (node) => {
    const m = await pickMachine(deps, node, "Prepare machine");
    if (m) await runPrepare(deps, m);
  });

  reg("agentSessions.connectMachine", async (node) => {
    const id = node?.kind === "machine" ? node.machine.id : undefined;
    if (id) deps.connect(id);
  });

  reg("agentSessions.disconnectMachine", async (node) => {
    const id = node?.kind === "machine" ? node.machine.id : undefined;
    if (id) deps.disconnect(id);
  });
}
