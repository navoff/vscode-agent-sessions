import { sessionKey, type Disposable, type SessionInfo, type SessionProvider } from "@agent-sessions/core";
import { PROTOCOL_VERSION, type ClientMessage, type DaemonMessage } from "./protocol.js";
import { writePendingOpen } from "./pendingOpen.js";

export interface DaemonOptions {
  providers: SessionProvider[];
  version: string;
  home: string;
  debounceMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
  /** Called once, at the end of the first stop(). */
  onStop?: () => void;
  /** Called whenever the last client detaches. Not called from stop(). */
  onIdle?: () => void;
}

export interface DaemonClient {
  handle(msg: ClientMessage): void;
  detach(): void;
  readonly detached: boolean;
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

interface ClientState {
  send: (msg: DaemonMessage) => void;
  synced: boolean;
  detached: boolean;
  /** Completed hello with the right protocol; deleting needs it. */
  greeted: boolean;
}

export class Daemon {
  private current = new Map<string, SessionInfo>();
  private readonly clients = new Set<ClientState>();
  private watchers: Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  /** Requesters served by the refresh currently in flight, if any. */
  private currentRequesters = new Set<ClientState>();
  private pendingFull = new Set<ClientState>();
  private pendingIncremental = false;
  private started = false;
  private stopped = false;
  private inFlight: Promise<void> | undefined;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: DaemonOptions) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.pollMs = opts.pollMs ?? 15_000;
    this.log = opts.log ?? (() => {});
  }

  get clientCount(): number {
    return this.clients.size;
  }

  attach(send: (msg: DaemonMessage) => void): DaemonClient {
    const state: ClientState = { send, synced: false, detached: false, greeted: false };
    this.clients.add(state);
    const detach = () => this.detachClient(state);
    return {
      handle: (msg) => this.handleFrom(state, msg),
      detach,
      get detached() {
        return state.detached;
      },
    };
  }

  private detachClient(state: ClientState): void {
    if (state.detached) return;
    state.detached = true;
    this.clients.delete(state);
    this.pendingFull.delete(state);
    if (this.clients.size === 0) this.opts.onIdle?.();
  }

  /** A throwing send means the client's transport is gone: drop that client. */
  private safeSend(client: ClientState, msg: DaemonMessage): void {
    if (client.detached) return;
    try {
      client.send(msg);
    } catch (err) {
      this.log(`send failed, detaching client: ${String(err)}`);
      this.detachClient(client);
    }
  }

  private handleFrom(client: ClientState, msg: ClientMessage): void {
    if (this.stopped || client.detached) return;
    switch (msg.type) {
      case "hello":
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.safeSend(client, { type: "error", message: `unsupported protocol ${msg.protocol}, daemon speaks ${PROTOCOL_VERSION}` });
          this.detachClient(client);
          return;
        }
        client.greeted = true;
        this.safeSend(client, {
          type: "hello",
          protocol: PROTOCOL_VERSION,
          daemonVersion: this.opts.version,
          agents: this.opts.providers.map((p) => p.agent),
          home: this.opts.home,
        });
        return;
      case "snapshot":
        void this.refresh(client);
        return;
      case "ping":
        this.safeSend(client, { type: "pong" });
        return;
      case "shutdown":
        this.stop("shutdown requested");
        return;
      case "delete":
        if (!client.greeted) {
          this.safeSend(client, { type: "deleteResult", requestId: msg.requestId, ok: false, error: "handshake required" });
          return;
        }
        void this.deleteSession(client, msg);
        return;
      case "rename":
        if (!client.greeted) {
          this.safeSend(client, { type: "renameResult", requestId: msg.requestId, ok: false, error: "handshake required" });
          return;
        }
        void this.renameSession(client, msg);
        return;
      case "pendingOpen":
        if (!client.greeted) {
          this.safeSend(client, { type: "pendingOpenResult", requestId: msg.requestId, ok: false, error: "handshake required" });
          return;
        }
        void this.pendingOpen(client, msg);
        return;
    }
  }

  /** Records a session for a window on its folder to open; see pendingOpen.ts. */
  private async pendingOpen(client: ClientState, msg: Extract<ClientMessage, { type: "pendingOpen" }>): Promise<void> {
    let error: string | undefined;
    try {
      await writePendingOpen(this.opts.home, msg.session, Date.now());
      this.log(`${msg.session.agent}: pending open of ${msg.session.id} in ${msg.session.cwd}`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.log(`${msg.session.agent}: pending open of ${msg.session.id} failed: ${error}`);
    }
    if (this.stopped) return;
    this.safeSend(client, error === undefined ? { type: "pendingOpenResult", requestId: msg.requestId, ok: true } : { type: "pendingOpenResult", requestId: msg.requestId, ok: false, error });
  }

  /**
   * Deletes a session through its provider and answers only the requester.
   * On success a refresh sends every synced client, the requester included,
   * a "changed" with the removal.
   */
  private async deleteSession(client: ClientState, msg: Extract<ClientMessage, { type: "delete" }>): Promise<void> {
    const provider = this.opts.providers.find((p) => p.agent === msg.agent);
    let error: string | undefined;
    if (!provider) {
      error = `unknown agent ${JSON.stringify(msg.agent.slice(0, 40))}`;
    } else if (!provider.delete) {
      error = `deleting ${msg.agent} sessions is not supported`;
    } else {
      try {
        await provider.delete(msg.id);
        this.log(`${msg.agent}: deleted session ${msg.id}`);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        this.log(`${msg.agent}: delete ${msg.id} failed: ${error}`);
      }
    }
    if (this.stopped) return;
    this.safeSend(client, error === undefined ? { type: "deleteResult", requestId: msg.requestId, ok: true } : { type: "deleteResult", requestId: msg.requestId, ok: false, error });
    if (error === undefined) void this.refresh(undefined);
  }

  /**
   * Renames a session through its provider and answers only the requester.
   * On success a refresh sends every synced client the new title.
   */
  private async renameSession(client: ClientState, msg: Extract<ClientMessage, { type: "rename" }>): Promise<void> {
    const provider = this.opts.providers.find((p) => p.agent === msg.agent);
    let error: string | undefined;
    if (!provider) {
      error = `unknown agent ${JSON.stringify(msg.agent.slice(0, 40))}`;
    } else if (!provider.rename) {
      error = `renaming ${msg.agent} sessions is not supported`;
    } else {
      try {
        await provider.rename(msg.id, msg.title);
        this.log(`${msg.agent}: renamed session ${msg.id}`);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        this.log(`${msg.agent}: rename ${msg.id} failed: ${error}`);
      }
    }
    if (this.stopped) return;
    this.safeSend(client, error === undefined ? { type: "renameResult", requestId: msg.requestId, ok: true } : { type: "renameResult", requestId: msg.requestId, ok: false, error });
    if (error === undefined) void this.refresh(undefined);
  }

  /** Stops the daemon; `reason` is logged on the first call. */
  stop(reason?: string): void {
    const first = !this.stopped;
    if (first && reason) this.opts.log?.(`stopping: ${reason}`);
    this.stopped = true;
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const c of [...this.clients]) {
      c.detached = true;
      this.clients.delete(c);
    }
    this.pendingFull.clear();
    if (first) this.opts.onStop?.();
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
    this.debounceTimer = setTimeout(() => void this.refresh(undefined), this.debounceMs);
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

  private broadcastDiff(next: Map<string, SessionInfo>, except: Set<ClientState>): void {
    const upserted: SessionInfo[] = [];
    const removed: string[] = [];
    for (const [k, s] of next) {
      const prev = this.current.get(k);
      if (!prev || !sameSession(prev, s)) upserted.push(s);
    }
    for (const k of this.current.keys()) if (!next.has(k)) removed.push(k);
    if (upserted.length === 0 && removed.length === 0) return;
    for (const c of [...this.clients]) {
      if (c.synced && !c.detached && !except.has(c)) this.safeSend(c, { type: "changed", upserted, removed });
    }
  }

  private async runRefresh(requesters: Set<ClientState>): Promise<void> {
    const next = await this.collect();
    if (this.stopped) return;
    const live = new Set([...requesters].filter((c) => !c.detached));
    this.broadcastDiff(next, live);
    this.current = next;
    const sessions = [...next.values()];
    for (const c of live) {
      if (c.detached) continue;
      this.safeSend(c, { type: "snapshot", sessions });
      c.synced = true;
    }
  }

  /** `requester` undefined means an incremental refresh from watch/poll. */
  private async refresh(requester: ClientState | undefined): Promise<void> {
    if (this.stopped) return;
    this.ensureStarted();
    if (this.refreshing) {
      // A requester already covered by the run in flight gets its reply from
      // that run; only a requester not yet covered needs a follow-up refresh.
      if (requester) {
        if (!this.currentRequesters.has(requester)) this.pendingFull.add(requester);
      } else {
        this.pendingIncremental = true;
      }
      return;
    }
    void this.refreshMany(requester ? new Set([requester]) : new Set());
  }

  private async refreshMany(requesters: Set<ClientState>): Promise<void> {
    if (this.stopped) return;
    this.refreshing = true;
    this.currentRequesters = requesters;
    const run = this.runRefresh(requesters);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.refreshing = false;
      this.inFlight = undefined;
      this.currentRequesters = new Set();
      if (this.pendingFull.size > 0) {
        const more = this.pendingFull;
        this.pendingFull = new Set();
        this.pendingIncremental = false;
        void this.refreshMany(more);
      } else if (this.pendingIncremental) {
        this.pendingIncremental = false;
        this.schedule();
      }
    }
  }

  /** Resolves when no refresh is running and no full refresh is queued. */
  async drain(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }
}
