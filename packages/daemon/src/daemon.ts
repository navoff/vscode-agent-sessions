import { sessionKey, type Disposable, type SessionInfo, type SessionProvider } from "@agent-sessions/core";
import { PROTOCOL_VERSION, type ClientMessage, type DaemonMessage } from "./protocol.js";

export interface DaemonOptions {
  providers: SessionProvider[];
  send: (msg: DaemonMessage) => void;
  version: string;
  home: string;
  debounceMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
}

export function sameSession(a: SessionInfo, b: SessionInfo): boolean {
  return (
    a.title === b.title &&
    a.cwd === b.cwd &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.status === b.status &&
    a.live?.pid === b.live?.pid &&
    a.live?.statusUpdatedAt === b.live?.statusUpdatedAt
  );
}

export class Daemon {
  private current = new Map<string, SessionInfo>();
  private watchers: Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private pending = false;
  private started = false;
  private stopped = false;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: DaemonOptions) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.pollMs = opts.pollMs ?? 15_000;
    this.log = opts.log ?? (() => {});
  }

  handle(msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.opts.send({ type: "error", message: `unsupported protocol ${msg.protocol}, daemon speaks ${PROTOCOL_VERSION}` });
          this.stop();
          return;
        }
        this.opts.send({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          daemonVersion: this.opts.version,
          agents: this.opts.providers.map((p) => p.agent),
          home: this.opts.home,
        });
        return;
      case "snapshot":
        void this.refresh(true);
        return;
      case "ping":
        this.opts.send({ type: "pong" });
        return;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private ensureStarted(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const p of this.opts.providers) this.watchers.push(p.watch(() => this.schedule()));
    this.pollTimer = setInterval(() => this.schedule(), this.pollMs);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(false), this.debounceMs);
  }

  private async collect(): Promise<Map<string, SessionInfo>> {
    const next = new Map<string, SessionInfo>();
    for (const p of this.opts.providers) {
      let list: SessionInfo[];
      try {
        list = await p.snapshot();
      } catch (err) {
        this.log(`${p.agent}: snapshot failed, keeping previous: ${String(err)}`);
        for (const [k, s] of this.current) if (s.agent === p.agent) next.set(k, s);
        continue;
      }
      for (const s of list) next.set(sessionKey(s), s);
    }
    return next;
  }

  private async refresh(full: boolean): Promise<void> {
    this.ensureStarted();
    if (this.refreshing) {
      this.pending = true;
      return;
    }
    this.refreshing = true;
    try {
      const next = await this.collect();
      if (this.stopped) return;
      if (full) {
        this.current = next;
        this.opts.send({ type: "snapshot", sessions: [...next.values()] });
        return;
      }
      const upserted: SessionInfo[] = [];
      const removed: string[] = [];
      for (const [k, s] of next) {
        const prev = this.current.get(k);
        if (!prev || !sameSession(prev, s)) upserted.push(s);
      }
      for (const k of this.current.keys()) if (!next.has(k)) removed.push(k);
      this.current = next;
      if (upserted.length > 0 || removed.length > 0) this.opts.send({ type: "changed", upserted, removed });
    } finally {
      this.refreshing = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }
}
