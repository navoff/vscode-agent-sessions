import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SessionInfo } from "@agent-sessions/core";
import { parseDaemonMessage, PROTOCOL_VERSION, type ClientMessage, type HelloInfo } from "@agent-sessions/daemon";

export interface LineClientEvents {
  onHello(info: HelloInfo): void;
  onSnapshot(sessions: SessionInfo[]): void;
  onChanged(upserted: SessionInfo[], removed: string[]): void;
  onError(message: string): void;
  onClose(): void;
}

export interface LineClientOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  helloTimeoutMs?: number;
}

export class LineClient {
  private closed = false;
  private helloTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly helloTimeoutMs: number;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly events: LineClientEvents,
    opts: LineClientOptions = {},
  ) {
    this.pingIntervalMs = opts.pingIntervalMs ?? 10_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
    const rl = createInterface({ input });
    rl.on("line", (line) => this.onLine(line));
    rl.on("close", () => this.close());
  }

  start(): void {
    this.send({ type: "hello", protocol: PROTOCOL_VERSION });
    this.helloTimer = setTimeout(() => this.fail("hello timeout"), this.helloTimeoutMs);
  }

  dispose(): void {
    this.close();
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
      this.events.onError(`unparsable message: ${line.slice(0, 200)}`);
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
    this.events.onClose();
  }
}
