import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentKind, SessionInfo } from "@agent-sessions/core";
import { parseDaemonMessage, PROTOCOL_VERSION, type ClientMessage, type HelloInfo } from "@agent-sessions/daemon";

export interface LineClientEvents {
  onHello(info: HelloInfo): void;
  onSnapshot(sessions: SessionInfo[]): void;
  onChanged(upserted: SessionInfo[], removed: string[]): void;
  onError(message: string): void;
  /** Non-fatal problems such as an unparsable line; the connection stays open. */
  onWarning?(message: string): void;
  onClose(): void;
}

export interface LineClientOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  helloTimeoutMs?: number;
  /** How long a delete request may wait for its "deleteResult". Default 30 s. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class LineClient {
  private closed = false;
  private readonly rl: Interface;
  private helloTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;
  private readonly onInputError = (err: unknown) => this.fail(`input stream error: ${String(err)}`);
  private readonly onOutputError = (err: unknown) => this.fail(`output stream error: ${String(err)}`);

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly events: LineClientEvents,
    opts: LineClientOptions = {},
  ) {
    this.pingIntervalMs = opts.pingIntervalMs ?? 10_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.input.on("error", this.onInputError);
    this.output.on("error", this.onOutputError);
    this.rl = createInterface({ input: this.input });
    this.rl.on("line", (line) => this.onLine(line));
    this.rl.on("close", () => this.close());
  }

  start(): void {
    this.send({ type: "hello", protocol: PROTOCOL_VERSION });
    this.helloTimer = setTimeout(() => this.fail("hello timeout"), this.helloTimeoutMs);
  }

  dispose(): void {
    this.close();
  }

  /** Asks the daemon to exit even though other clients may be attached. */
  sendShutdown(): void {
    this.send({ type: "shutdown" });
  }

  /**
   * Asks the daemon to delete a session permanently. Resolves on success;
   * rejects with the daemon's error, on timeout, or when the connection
   * closes first.
   */
  deleteSession(agent: AgentKind, id: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("not connected"));
    const requestId = String(++this.nextRequestId);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`no answer from the daemon within ${Math.round(this.requestTimeoutMs / 1000)} s`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.send({ type: "delete", requestId, agent, id });
    return done;
  }

  private settle(requestId: string, error: Error | undefined): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    if (error) p.reject(error);
    else p.resolve();
  }

  private send(msg: ClientMessage): void {
    if (this.closed) return;
    try {
      this.output.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.fail(`write failed: ${String(err)}`);
    }
  }

  private onLine(line: string): void {
    if (this.closed || !line.trim()) return;
    const msg = parseDaemonMessage(line);
    if (!msg) {
      this.events.onWarning?.(`ignoring unparsable line: ${line.slice(0, 200)}`);
      return;
    }
    switch (msg.type) {
      case "hello":
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = undefined;
        this.events.onHello(msg);
        this.send({ type: "snapshot" });
        this.startPing();
        return;
      case "snapshot":
        this.events.onSnapshot(msg.sessions);
        return;
      case "changed":
        this.events.onChanged(msg.upserted, msg.removed);
        return;
      case "pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      case "deleteResult":
        this.settle(msg.requestId, msg.ok ? undefined : new Error(msg.error ?? "delete failed"));
        return;
      case "error":
        this.events.onError(msg.message);
        return;
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" });
      if (!this.pongTimer) this.pongTimer = setTimeout(() => this.fail("pong timeout"), this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.events.onError(reason);
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    for (const id of [...this.pending.keys()]) this.settle(id, new Error("connection closed before the daemon answered"));
    this.input.off("error", this.onInputError);
    this.output.off("error", this.onOutputError);
    this.rl.close();
    this.events.onClose();
  }
}
