import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isValidSshHost } from "./sshConfig.js";

export interface MachineRecord {
  id: string;
  name: string;
  sshHost: string;
  enabled: boolean;
  autoConnect: boolean;
  remoteNode?: string;
  daemonVersion?: string;
  remoteHome?: string;
}

export interface MachinesFile {
  version: 1;
  machines: MachineRecord[];
}

const EMPTY: MachinesFile = { version: 1, machines: [] };

function toRecord(raw: unknown): MachineRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.sshHost !== "string" || !isValidSshHost(r.sshHost)) return undefined;
  const rec: MachineRecord = {
    id: r.id,
    name: typeof r.name === "string" && r.name ? r.name : r.id,
    sshHost: r.sshHost,
    enabled: r.enabled !== false,
    autoConnect: r.autoConnect === true,
  };
  if (typeof r.remoteNode === "string") rec.remoteNode = r.remoteNode;
  if (typeof r.daemonVersion === "string") rec.daemonVersion = r.daemonVersion;
  if (typeof r.remoteHome === "string") rec.remoteHome = r.remoteHome;
  return rec;
}

// Returns undefined when the text is not JSON or has no `machines` array.
export function parseMachinesFileStrict(text: string): MachinesFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = (raw as { machines?: unknown })?.machines;
  if (!Array.isArray(list)) return undefined;
  return { version: 1, machines: list.map(toRecord).filter((m): m is MachineRecord => m !== undefined) };
}

export function parseMachinesFile(text: string): MachinesFile {
  return parseMachinesFileStrict(text) ?? { ...EMPTY, machines: [] };
}

export function serializeMachinesFile(f: MachinesFile): string {
  return JSON.stringify(f, null, 2) + "\n";
}

// A missing or empty file is an empty list; an unreadable, unparsable or
// schema-invalid file is undefined so that callers never overwrite it.
export async function readMachinesFile(path: string): Promise<MachinesFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, machines: [] };
    return undefined;
  }
  if (!text.trim()) return { version: 1, machines: [] };
  return parseMachinesFileStrict(text);
}

export async function writeMachinesFile(path: string, f: MachinesFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, serializeMachinesFile(f), "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function addMachine(f: MachinesFile, sshHost: string, name?: string): MachinesFile {
  const ids = new Set(f.machines.map((m) => m.id));
  let id = sshHost;
  for (let n = 2; ids.has(id); n++) id = `${sshHost}-${n}`;
  return { version: 1, machines: [...f.machines, { id, name: name ?? sshHost, sshHost, enabled: true, autoConnect: false }] };
}

export function updateMachine(f: MachinesFile, id: string, patch: Partial<Omit<MachineRecord, "id">>): MachinesFile {
  return { version: 1, machines: f.machines.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}

export function removeMachine(f: MachinesFile, id: string): MachinesFile {
  return { version: 1, machines: f.machines.filter((m) => m.id !== id) };
}
