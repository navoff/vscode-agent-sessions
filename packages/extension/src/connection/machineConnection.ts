import type { Readable, Writable } from "node:stream";
import { sessionKey, type SessionInfo } from "@agent-sessions/core";
import { LineClient, type LineClientOptions } from "./lineClient.js";

export type MachineState = "disconnected" | "connecting" | "connected" | "error";

export interface DaemonProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
}

export type ProcessFactory = () => DaemonProcess;

export interface MachineConnectionEvents {
  onStateChange(state: MachineState, error?: string): void;
  onSessions(sessions: Map<string, SessionInfo>): void;
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
  sessions = new Map<string, SessionInfo>();
  private client: LineClient | undefined;
  private proc: DaemonProcess | undefined;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private wantConnected = false;

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

  private open(): void {
    this.setState("connecting");
    let proc: DaemonProcess;
    try {
      proc = this.factory();
    } catch (err) {
      this.onFailure(String(err instanceof Error ? err.message : err));
      return;
    }
    this.proc = proc;
    proc.onExit((code) => {
      if (this.proc !== proc) return;
      this.onFailure(`daemon exited with code ${code ?? "null"}`);
    });
    this.client = new LineClient(
      proc.stdout,
      proc.stdin,
      {
        onHello: (info) => {
          this.attempt = 0;
          this.daemonVersion = info.daemonVersion;
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
