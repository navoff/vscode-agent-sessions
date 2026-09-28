import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Disposable, SessionInfo, SessionProvider } from "../types.js";
import { guardWatcher } from "../util/watch.js";
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

export class ClaudeProvider implements SessionProvider {
  readonly agent = "claude" as const;
  private readonly claudeDir: string;
  private readonly listSessions: ListSessions;
  private readonly isAlive: (pid: number) => boolean;
  private readonly log: (msg: string) => void;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
    this.listSessions = opts.listSessions ?? sdkListSessions;
    this.isAlive = opts.isAlive ?? isProcessAlive;
    this.log = opts.log ?? (() => {});
  }

  async snapshot(): Promise<SessionInfo[]> {
    const [sessions, registry] = await Promise.all([
      this.listSessions().catch((err: unknown) => {
        this.log(`claude: listSessions failed: ${String(err)}`);
        return [] as SdkSessionInfo[];
      }),
      readClaudeRegistry(join(this.claudeDir, "sessions"), this.isAlive),
    ]);
    return sessions.map((s) => {
      const live = registry.get(s.sessionId);
      const info: SessionInfo = {
        agent: "claude",
        id: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
        cwd: s.cwd ?? live?.cwd ?? "",
        createdAt: s.createdAt ?? s.lastModified,
        updatedAt: Math.max(s.lastModified, live?.updatedAt ?? 0),
        status: live ? (live.status === "busy" ? "running" : "idle") : "idle",
      };
      if (live) info.live = { pid: live.pid, statusUpdatedAt: live.statusUpdatedAt };
      return info;
    });
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
