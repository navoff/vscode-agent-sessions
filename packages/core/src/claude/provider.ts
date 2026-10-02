import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Disposable, SessionInfo, SessionProvider } from "../types.js";
import { normalizeFirstPrompt } from "../util/firstPrompt.js";
import { isValidSessionId } from "../util/sessionId.js";
import { normalizeSessionTitle } from "../util/sessionTitle.js";
import { guardWatcher } from "../util/watch.js";
import { indexSessionFiles, readLastMessageTimestamp } from "./activity.js";
import { readPromptText } from "./firstPrompt.js";
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
export type DeleteSession = (sessionId: string, options?: { dir?: string }) => Promise<void>;
export type RenameSession = (sessionId: string, title: string, options?: { dir?: string }) => Promise<void>;

export interface ClaudeProviderOptions {
  claudeDir?: string;
  listSessions?: ListSessions;
  /** Replaces the SDK's deleteSession; for tests. */
  deleteSession?: DeleteSession;
  /** Replaces the SDK's renameSession; for tests. */
  renameSession?: RenameSession;
  isAlive?: (pid: number) => boolean;
  log?: (msg: string) => void;
}

async function sdkListSessions(): Promise<SdkSessionInfo[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return (await sdk.listSessions({})) as SdkSessionInfo[];
}

async function sdkDeleteSession(sessionId: string, options?: { dir?: string }): Promise<void> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  await sdk.deleteSession(sessionId, options);
}

async function sdkRenameSession(sessionId: string, title: string, options?: { dir?: string }): Promise<void> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  await sdk.renameSession(sessionId, title, options);
}

/** Every `<projects>/<project>/<id>.jsonl` that exists. */
async function findTranscripts(projectsDir: string, id: string): Promise<string[]> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const project of projects) {
    const path = join(projectsDir, project, `${id}.jsonl`);
    try {
      if ((await stat(path)).isFile()) found.push(path);
    } catch {
      // not in this project
    }
  }
  return found;
}

interface PromptEntry {
  sdk: string;
  text: string | undefined;
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
  private readonly deleteSession: DeleteSession;
  private readonly renameSession: RenameSession;
  private readonly isAlive: (pid: number) => boolean;
  private readonly log: (msg: string) => void;
  private readonly activity = new Map<string, ActivityEntry>();
  /** First prompts by transcript path; a prompt never changes, so each is read once. */
  private readonly prompts = new Map<string, PromptEntry>();
  /** Working directories from the last snapshot, passed to the SDK as `dir`. */
  private cwds = new Map<string, string>();

  constructor(opts: ClaudeProviderOptions = {}) {
    this.claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
    this.listSessions = opts.listSessions ?? sdkListSessions;
    this.deleteSession = opts.deleteSession ?? sdkDeleteSession;
    this.renameSession = opts.renameSession ?? sdkRenameSession;
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
    const prompts = new Map<string, string>();
    for (const s of sessions) {
      const path = files.get(s.sessionId);
      if (!path) continue;
      const ts = await this.messageTime(path);
      if (ts !== undefined) updated.set(s.sessionId, ts);
      const prompt = s.firstPrompt ? await this.promptText(path, s.firstPrompt) : undefined;
      if (prompt !== undefined) prompts.set(s.sessionId, prompt);
      seen.add(path);
    }
    for (const key of this.activity.keys()) if (!seen.has(key)) this.activity.delete(key);
    for (const key of this.prompts.keys()) if (!seen.has(key)) this.prompts.delete(key);
    this.cwds = new Map(sessions.filter((s) => s.cwd).map((s) => [s.sessionId, s.cwd as string]));
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
      const firstPrompt = normalizeFirstPrompt(prompts.get(s.sessionId) ?? s.firstPrompt);
      if (firstPrompt) info.firstPrompt = firstPrompt;
      if (live) info.live = { pid: live.pid, statusUpdatedAt: live.statusUpdatedAt };
      return info;
    });
  }

  /**
   * Deletes the session transcript and its subagent transcripts through the
   * SDK. A session with a live Claude Code process (busy or idle) is
   * refused: that process would write the transcript again. So is an id
   * whose transcript exists in several project folders, where the SDK
   * would delete whichever it finds first.
   */
  async delete(id: string): Promise<void> {
    if (!isValidSessionId(id)) throw new Error(`invalid Claude session id ${JSON.stringify(id.slice(0, 80))}`);
    const live = (await readClaudeRegistry(join(this.claudeDir, "sessions"), this.isAlive)).get(id);
    if (live) throw new Error(`the session is open in Claude Code (pid ${live.pid}); close it in Claude Code first`);
    const files = await findTranscripts(join(this.claudeDir, "projects"), id);
    if (files.length > 1) {
      throw new Error(`the session has transcripts in ${files.length} project folders (${files.map((f) => f.split("/").at(-2)).join(", ")}); not deleting any of them`);
    }
    const dir = this.cwds.get(id);
    try {
      await this.deleteSession(id, dir ? { dir } : undefined);
    } catch (err) {
      // The transcript lives under another project than its cwd (the cwd
      // changed during the session); it is the only one, so search for it.
      if (!dir || !/not found in project directory for/.test(String(err))) throw err;
      await this.deleteSession(id);
    }
    this.log(`claude: deleted session ${id}`);
  }

  /**
   * Renames the session through the SDK, which appends a custom-title entry
   * to the transcript as /rename does. A session with a live Claude Code
   * process is renamed too: that process keeps the new title. An id whose
   * transcript exists in several project folders is refused, as in delete().
   */
  async rename(id: string, title: string): Promise<void> {
    if (!isValidSessionId(id)) throw new Error(`invalid Claude session id ${JSON.stringify(id.slice(0, 80))}`);
    const name = normalizeSessionTitle(title);
    const files = await findTranscripts(join(this.claudeDir, "projects"), id);
    if (files.length > 1) {
      throw new Error(`the session has transcripts in ${files.length} project folders (${files.map((f) => f.split("/").at(-2)).join(", ")}); not renaming any of them`);
    }
    const dir = this.cwds.get(id);
    try {
      await this.renameSession(id, name, dir ? { dir } : undefined);
    } catch (err) {
      // The transcript lives under another project than its cwd; see delete().
      if (!dir || !/not found in project directory for/.test(String(err))) throw err;
      await this.renameSession(id, name);
    }
    this.log(`claude: renamed session ${id}`);
  }

  /**
   * The first prompt with its line breaks, taken from the transcript: the
   * SDK gives it as one line. Undefined when it is not found there.
   */
  private async promptText(path: string, sdkFirstPrompt: string): Promise<string | undefined> {
    const cached = this.prompts.get(path);
    if (cached && cached.sdk === sdkFirstPrompt) return cached.text;
    let text: string | undefined;
    try {
      text = await readPromptText(path, sdkFirstPrompt);
    } catch {
      text = undefined;
    }
    this.prompts.set(path, { sdk: sdkFirstPrompt, text });
    return text;
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
