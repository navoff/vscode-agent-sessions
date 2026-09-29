import type { Readable, Writable } from "node:stream";
import { sessionKey, type SessionInfo } from "@agent-sessions/core";
import { LineClient, type LineClientOptions } from "./lineClient.js";

export type MachineState = "disconnected" | "connecting" | "connected" | "error";

export interface DaemonProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
  /** The last few stderr lines, joined by " | ", if the process keeps them. */
  lastStderr?(): string;
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

export type ProcessFactory = () => DaemonProcess | Promise<DaemonProcess>;

export interface MachineConnectionEvents {
  onStateChange(state: MachineState, error?: string): void;
  onSessions(sessions: Map<string, SessionInfo>): void;
  onWarning?(message: string): void;
}

export interface MachineConnectionOptions {
  autoReconnect: boolean;
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
      this.onFailure(`daemon exited with code ${code ?? "null"}${stderr ? `: ${stderr}` : ""}`);
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
    if (!this.opts.autoReconnect) {
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
