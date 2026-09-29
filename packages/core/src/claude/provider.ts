import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Disposable, SessionInfo, SessionProvider } from "../types.js";
import { guardWatcher } from "../util/watch.js";
import { indexSessionFiles, readLastMessageTimestamp } from "./activity.js";
import { isProcessAlive, readClaudeRegistry } from "./registry.js";

export interface SdkSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  createdAt?: number;
}

export type ListSessions = () => Promise<SdkSessionInfo[]>;

export interface ClaudeProviderOptions {
  claudeDir?: string;
  listSessions?: ListSessions;
  isAlive?: (pid: number) => boolean;
  log?: (msg: string) => void;
}

async function sdkListSessions(): Promise<SdkSessionInfo[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return (await sdk.listSessions({})) as SdkSessionInfo[];
}

interface ActivityEntry {
  mtimeMs: number;
  size: number;
  ts: number | undefined;
}

export class ClaudeProvider implements SessionProvider {
  readonly agent = "claude" as const;
  private readonly claudeDir: string;
  private readonly listSessions: ListSessions;
  private readonly isAlive: (pid: number) => boolean;
  private readonly log: (msg: string) => void;
  private readonly activity = new Map<string, ActivityEntry>();

  constructor(opts: ClaudeProviderOptions = {}) {
    this.claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
    this.listSessions = opts.listSessions ?? sdkListSessions;
    this.isAlive = opts.isAlive ?? isProcessAlive;
    this.log = opts.log ?? (() => {});
  }

  async snapshot(): Promise<SessionInfo[]> {
    let sessions: SdkSessionInfo[];
    try {
      sessions = await this.listSessions();
    } catch (err) {
      // Rethrow so the daemon keeps the previous Claude sessions.
      this.log(`claude: listSessions failed: ${String(err)}`);
      throw err;
    }
    const registry = await readClaudeRegistry(join(this.claudeDir, "sessions"), this.isAlive);
    const files = await indexSessionFiles(join(this.claudeDir, "projects"));
    const seen = new Set<string>();
    const updated = new Map<string, number>();
    for (const s of sessions) {
      const path = files.get(s.sessionId);
      if (!path) continue;
      const ts = await this.messageTime(path);
      if (ts !== undefined) updated.set(s.sessionId, ts);
      seen.add(path);
    }
    for (const key of this.activity.keys()) if (!seen.has(key)) this.activity.delete(key);
    return sessions.map((s) => {
      const live = registry.get(s.sessionId);
      const info: SessionInfo = {
        agent: "claude",
        id: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
        cwd: s.cwd ?? live?.cwd ?? "",
        createdAt: s.createdAt ?? s.lastModified,
        updatedAt: updated.get(s.sessionId) ?? s.lastModified,
        status: live ? (live.status === "busy" ? "running" : "idle") : "idle",
      };
      if (live) info.live = { pid: live.pid, statusUpdatedAt: live.statusUpdatedAt };
      return info;
    });
  }

  private async messageTime(path: string): Promise<number | undefined> {
    try {
      const st = await stat(path);
      const cached = this.activity.get(path);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.ts;
      const ts = await readLastMessageTimestamp(path, st.size);
      this.activity.set(path, { mtimeMs: st.mtimeMs, size: st.size, ts });
      return ts;
    } catch {
      return undefined;
    }
  }

  watch(onChange: () => void): Disposable {
    const watchers: FSWatcher[] = [];
    const targets: Array<[string, boolean]> = [
      [join(this.claudeDir, "sessions"), false],
      [join(this.claudeDir, "projects"), true],
    ];
    for (const [dir, recursive] of targets) {
      try {
        watchers.push(guardWatcher(watch(dir, { recursive }, () => onChange()), (msg) => this.log(`claude: ${msg}`)));
      } catch (err) {
        this.log(`claude: cannot watch ${dir}: ${String(err)}`);
      }
    }
    return { dispose: () => watchers.forEach((w) => w.close()) };
  }
}
