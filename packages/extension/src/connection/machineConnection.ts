import type { Readable, Writable } from "node:stream";
import { sessionKey, type AgentKind, type SessionInfo } from "@agent-sessions/core";
import { LineClient, type LineClientOptions } from "./lineClient.js";

export type MachineState = "disconnected" | "connecting" | "connected" | "error";

export interface DaemonProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
  /** The last few stderr lines, joined by " | ", if the process keeps them. */
  lastStderr?(): string;
  /** Error text when onExit reports `null` (closed or killed); default "connection closed". */
  closedMessage?: string;
}

/** Keeps the last `max` non-empty lines written to a stderr stream. */
export function createStderrTail(max = 5): { push(chunk: string | Buffer): void; text(): string } {
  const lines: string[] = [];
  let partial = "";
  return {
    push(chunk) {
      const parts = (partial + String(chunk)).split("\n");
      partial = parts.pop() ?? "";
      for (const l of parts) if (l.trim()) lines.push(l.trim());
      lines.splice(0, Math.max(0, lines.length - max));
    },
    text() {
      const all = partial.trim() ? [...lines, partial.trim()].slice(-max) : lines;
      return all.join(" | ");
    },
  };
}

/**
 * Whether `message` is the daemon's answer to a hello with another protocol
 * version ("unsupported protocol 2, daemon speaks 1"): the daemon on the
 * other side is older or newer than this extension.
 */
export function isProtocolMismatch(message: string | undefined): boolean {
  return message !== undefined && /\bunsupported protocol \d+, daemon speaks \d+/.test(message);
}

export type ProcessFactory = () => DaemonProcess | Promise<DaemonProcess>;

export interface MachineConnectionEvents {
  onStateChange(state: MachineState, error?: string): void;
  onSessions(sessions: Map<string, SessionInfo>): void;
  onWarning?(message: string): void;
}

export interface MachineConnectionOptions {
  autoReconnect: boolean;
  /**
   * Whether to keep reconnecting after a protocol mismatch. Default true.
   * Off for a remote machine, where only "Prepare Machine" replaces the daemon.
   */
  retryOnProtocolMismatch?: boolean;
  backoffMs?: number[];
  clientOptions?: LineClientOptions;
}

const DEFAULT_BACKOFF = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

export class MachineConnection {
  state: MachineState = "disconnected";
  error: string | undefined;
  daemonVersion: string | undefined;
  home: string | undefined;
  sessions = new Map<string, SessionInfo>();
  private client: LineClient | undefined;
  private proc: DaemonProcess | undefined;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private wantConnected = false;
  /** Bumped on every open and teardown, so a factory that resolves late is discarded. */
  private generation = 0;

  constructor(
    readonly machineId: string,
    private readonly factory: ProcessFactory,
    private readonly events: MachineConnectionEvents,
    private readonly opts: MachineConnectionOptions,
  ) {}

  connect(): void {
    this.wantConnected = true;
    this.clearRetry();
    if (this.state === "connecting" || this.state === "connected") return;
    this.open();
  }

  disconnect(): void {
    this.wantConnected = false;
    this.clearRetry();
    this.teardown();
    this.sessions = new Map();
    this.events.onSessions(this.sessions);
    this.setState("disconnected");
  }

  dispose(): void {
    this.disconnect();
  }

  /** Asks the connected daemon to exit; no-op without a live client. */
  requestShutdown(): void {
    this.client?.sendShutdown();
  }

  /** Deletes a session through the connected daemon; see LineClient.deleteSession. */
  deleteSession(agent: AgentKind, id: string): Promise<void> {
    if (!this.client || this.state !== "connected") return Promise.reject(new Error("the machine is not connected"));
    return this.client.deleteSession(agent, id);
  }

  /** Renames a session through the connected daemon; see LineClient.renameSession. */
  renameSession(agent: AgentKind, id: string, title: string): Promise<void> {
    if (!this.client || this.state !== "connected") return Promise.reject(new Error("the machine is not connected"));
    return this.client.renameSession(agent, id, title);
  }

  /** Moves a session to another folder through the connected daemon; see LineClient.moveSession. */
  moveSession(agent: AgentKind, id: string, cwd: string): Promise<void> {
    if (!this.client || this.state !== "connected") return Promise.reject(new Error("the machine is not connected"));
    return this.client.moveSession(agent, id, cwd);
  }

  /** Records a pending open through the connected daemon; see LineClient.pendingOpen. */
  pendingOpen(session: SessionInfo): Promise<void> {
    if (!this.client || this.state !== "connected") return Promise.reject(new Error("the machine is not connected"));
    return this.client.pendingOpen(session);
  }

  private open(): void {
    this.setState("connecting");
    const gen = ++this.generation;
    Promise.resolve()
      .then(() => this.factory())
      .then(
        (proc) => {
          if (gen !== this.generation || !this.wantConnected) {
            proc.kill();
            return;
          }
          this.attach(proc);
        },
        (err: unknown) => {
          if (gen !== this.generation) return;
          this.onFailure(String(err instanceof Error ? err.message : err));
        },
      );
  }

  private attach(proc: DaemonProcess): void {
    this.proc = proc;
    proc.onExit((code) => {
      if (this.proc !== proc) return;
      const stderr = proc.lastStderr?.();
      const what = code === null ? (proc.closedMessage ?? "connection closed") : `daemon exited with code ${code}`;
      this.onFailure(`${what}${stderr ? `: ${stderr}` : ""}`);
    });
    this.client = new LineClient(
      proc.stdout,
      proc.stdin,
      {
        onHello: (info) => {
          this.attempt = 0;
          this.daemonVersion = info.daemonVersion;
          this.home = info.home;
          this.setState("connected");
        },
        onSnapshot: (list) => {
          this.sessions = new Map(list.map((s) => [sessionKey(s), s]));
          this.events.onSessions(this.sessions);
        },
        onChanged: (upserted, removed) => {
          for (const s of upserted) this.sessions.set(sessionKey(s), s);
          for (const k of removed) this.sessions.delete(k);
          this.events.onSessions(this.sessions);
        },
        onError: (message) => this.onFailure(message),
        onWarning: (message) => this.events.onWarning?.(message),
        onClose: () => {},
      },
      this.opts.clientOptions,
    );
    this.client.start();
  }

  private onFailure(message: string): void {
    if (!this.wantConnected) return;
    this.teardown();
    this.setState("error", message);
    if (!this.opts.autoReconnect || (this.opts.retryOnProtocolMismatch === false && isProtocolMismatch(message))) {
      this.wantConnected = false;
      return;
    }
    const delays = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private teardown(): void {
    this.generation++;
    const client = this.client;
    const proc = this.proc;
    this.client = undefined;
    this.proc = undefined;
    client?.dispose();
    proc?.kill();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private setState(state: MachineState, error?: string): void {
    this.state = state;
    this.error = error;
    this.events.onStateChange(state, error);
  }
}
