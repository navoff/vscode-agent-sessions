import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Disposable, SessionInfo, SessionProvider } from "../types.js";
import { fileLockHolder } from "../util/fileLock.js";
import { isValidSessionId } from "../util/sessionId.js";
import { normalizeSessionTitle } from "../util/sessionTitle.js";
import { guardWatcher } from "../util/watch.js";
import { AppServerExitError, appServerRequest, type AppServerRequest } from "./appServer.js";
import { listRolloutFiles } from "./discovery.js";
import { readRolloutInfo, type CodexRolloutInfo } from "./rollout.js";
import { readSessionIndex } from "./sessionIndex.js";

export interface CommandResult {
  /** Exit code, or null when the command was killed (timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command to completion. Rejects only when it cannot be started (the
 * error keeps its `code`, such as "ENOENT"); a non-zero exit or a timeout
 * resolves with `code`.
 */
export type CommandRunner = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<CommandResult>;

export const execFileRunner: CommandRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
      if (typeof e.code === "number") return resolve({ code: e.code, stdout, stderr });
      if (e.killed || (err as { signal?: string }).signal) return resolve({ code: null, stdout, stderr });
      reject(err);
    });
  });

const DELETE_TIMEOUT_MS = 30_000;
const RENAME_TIMEOUT_MS = 30_000;

/** The lines of stderr that start with "Error" if any, else the first 500 characters of the output. */
function errorText(r: CommandResult): string {
  const errors = r.stderr.split("\n").map((l) => l.trim()).filter((l) => /^Error\b/.test(l));
  if (errors.length) return errors.join(" | ").slice(0, 500);
  return (r.stderr.trim() || r.stdout.trim()).slice(0, 500);
}

export interface CodexProviderOptions {
  codexDir?: string;
  log?: (msg: string) => void;
  /** Environment for the codex commands; CODEX_BIN names the binary. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Replaces execFile; for tests. */
  runCommand?: CommandRunner;
  deleteTimeoutMs?: number;
  /** Replaces the request to `codex app-server`; for tests. */
  appServer?: AppServerRequest;
  renameTimeoutMs?: number;
  /** Where to read kernel file locks from; for tests. Default /proc/locks. */
  procLocksPath?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  info: CodexRolloutInfo | undefined;
}

export class CodexProvider implements SessionProvider {
  readonly agent = "codex" as const;
  private readonly codexDir: string;
  private readonly log: (msg: string) => void;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand: CommandRunner;
  private readonly deleteTimeoutMs: number;
  private readonly appServer: AppServerRequest;
  private readonly renameTimeoutMs: number;
  private readonly procLocksPath: string | undefined;

  constructor(opts: CodexProviderOptions = {}) {
    this.codexDir = opts.codexDir ?? join(homedir(), ".codex");
    this.log = opts.log ?? (() => {});
    this.env = opts.env ?? process.env;
    this.runCommand = opts.runCommand ?? execFileRunner;
    this.deleteTimeoutMs = opts.deleteTimeoutMs ?? DELETE_TIMEOUT_MS;
    this.appServer = opts.appServer ?? appServerRequest;
    this.renameTimeoutMs = opts.renameTimeoutMs ?? RENAME_TIMEOUT_MS;
    this.procLocksPath = opts.procLocksPath;
  }

  async snapshot(): Promise<SessionInfo[]> {
    const sessionsDir = join(this.codexDir, "sessions");
    const [files, titles] = await Promise.all([
      listRolloutFiles(sessionsDir),
      readSessionIndex(join(this.codexDir, "session_index.jsonl")),
    ]);
    const seen = new Set<string>();
    const result = new Map<string, SessionInfo>();
    for (const file of files) {
      seen.add(file);
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      let entry = this.cache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        let info: CodexRolloutInfo | undefined;
        try {
          info = await readRolloutInfo(file, st.size);
        } catch (err) {
          this.log(`codex: cannot read ${file}: ${String(err)}`);
        }
        entry = { mtimeMs: st.mtimeMs, size: st.size, info };
        this.cache.set(file, entry);
      }
      const info = entry.info;
      if (!info || !info.meta.isUserThread) continue;
      // Opening a thread in Codex appends bookkeeping events, so mtime is only a fallback.
      const updatedAt = info.activityAt ?? Math.trunc(st.mtimeMs);
      const existing = result.get(info.meta.id);
      if (existing && existing.updatedAt >= updatedAt) continue;
      const session: SessionInfo = {
        agent: "codex",
        id: info.meta.id,
        title: titles.get(info.meta.id) ?? info.title ?? info.meta.id,
        cwd: info.meta.cwd,
        createdAt: info.meta.createdAt || updatedAt,
        updatedAt,
        status: info.status,
      };
      if (info.firstPrompt) session.firstPrompt = info.firstPrompt;
      result.set(info.meta.id, session);
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return [...result.values()];
  }

  /**
   * Runs `attempt` on the codex binary: CODEX_BIN, else `codex` on PATH, else
   * `codex` found by a login shell, started as `bash shellArgs`: a remote
   * daemon runs under a non-login ssh session whose PATH may lack
   * ~/.local/bin. `attempt` rejects with code "ENOENT" when its file cannot
   * be started; any other outcome is final.
   */
  private async withCodex<T>(args: string[], shellArgs: string[], attempt: (file: string, args: string[], viaShell: boolean) => Promise<T>): Promise<T> {
    const bin = this.env.CODEX_BIN;
    try {
      return await attempt(bin || "codex", args, false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (bin) throw new Error(`CODEX_BIN ${bin} not found`);
      this.log("codex: codex not on PATH, trying a login shell");
      try {
        return await attempt("bash", shellArgs, true);
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") throw err2;
        throw new Error(`codex not found on PATH and no bash to look further: ${String(err2)}`);
      }
    }
  }

  /**
   * Deletes the session with `codex delete`, which also keeps Codex's own
   * index and state consistent; rollout files are never removed by hand.
   */
  async delete(id: string): Promise<void> {
    if (!isValidSessionId(id)) throw new Error(`invalid Codex session id ${JSON.stringify(id.slice(0, 80))}`);
    if (await this.isRunningNow(id)) throw new Error("the session is running, wait until it finishes or stop it before deleting");
    // A Codex process that has the thread open (the VS Code plugin, a TUI)
    // holds its writer lock, and codex delete fails with a truncated error.
    const holder = await fileLockHolder(join(this.codexDir, "thread-writer-locks", `${id.toLowerCase()}.lock`), this.procLocksPath);
    if (holder !== undefined) {
      throw new Error(
        `the session is open in Codex (process ${holder}). Close it in Codex, or reload the VS Code window that has it open, then try again`,
      );
    }
    const opts = { env: { ...this.env, CODEX_HOME: this.codexDir }, timeoutMs: this.deleteTimeoutMs };
    const result = await this.withCodex(
      // --force skips the interactive confirmation; the user confirmed in VS Code.
      ["delete", "--force", "--", id],
      ["-lc", 'CODEX_HOME="$2" exec codex delete --force -- "$1"', "_", id, this.codexDir],
      async (file, args, viaShell) => {
        let r: CommandResult;
        try {
          r = await this.runCommand(file, args, opts);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
          throw new Error(`cannot run codex: ${String(err)}`);
        }
        if (viaShell && r.code === 127) throw new Error("codex not found on PATH or in a login shell; set CODEX_BIN");
        return r;
      },
    );
    if (result.code !== 0) {
      const what = result.code === null ? `timed out after ${Math.round(this.deleteTimeoutMs / 1000)} s` : `exit ${result.code}`;
      const text = errorText(result);
      throw new Error(`codex delete failed (${what})${text ? `: ${text}` : ""}`);
    }
    this.log(`codex: deleted session ${id}`);
  }

  /**
   * Renames the session with `thread/name/set` of a `codex app-server`
   * started for this one request, so Codex writes its own session index. A
   * running thread, or one open in another Codex process, is renamed too:
   * the name goes to the index and the rollout is left alone. A window that
   * has the thread open may show the old name until it is reloaded.
   */
  async rename(id: string, title: string): Promise<void> {
    if (!isValidSessionId(id)) throw new Error(`invalid Codex session id ${JSON.stringify(id.slice(0, 80))}`);
    const params = { threadId: id, name: normalizeSessionTitle(title) };
    const opts = { env: { ...this.env, CODEX_HOME: this.codexDir }, timeoutMs: this.renameTimeoutMs };
    await this.withCodex(["app-server"], ["-lc", 'CODEX_HOME="$1" exec codex app-server', "_", this.codexDir], async (file, args, viaShell) => {
      try {
        await this.appServer(file, args, "thread/name/set", params, opts);
      } catch (err) {
        if (!(err instanceof AppServerExitError)) throw err;
        if (viaShell && err.exitCode === 127) throw new Error("codex not found on PATH or in a login shell; set CODEX_BIN");
        const text = errorText({ code: err.exitCode, stdout: "", stderr: err.stderr });
        throw new Error(`${err.message}${text ? `: ${text}` : ""}`);
      }
    });
    this.log(`codex: renamed session ${id}`);
  }

  /**
   * Whether the session's rollout ends in a started task, read from the
   * file now: the last snapshot may be up to a poll interval old. Rollouts
   * seen by a snapshot are found through the cache, others by their file
   * name (rollout-<time>-<id>.jsonl). No rollout found means not running.
   */
  private async isRunningNow(id: string): Promise<boolean> {
    let files = [...this.cache.entries()].filter(([, e]) => e.info?.meta.id === id).map(([f]) => f);
    if (files.length === 0) {
      const lower = id.toLowerCase();
      files = (await listRolloutFiles(join(this.codexDir, "sessions"))).filter((f) => basename(f).toLowerCase().endsWith(`-${lower}.jsonl`));
    }
    for (const file of files) {
      try {
        const info = await readRolloutInfo(file, (await stat(file)).size);
        if (info?.meta.id === id && info.status === "running") return true;
      } catch {
        // gone or unreadable: codex decides
      }
    }
    return false;
  }

  watch(onChange: () => void): Disposable {
    const watchers: FSWatcher[] = [];
    try {
      watchers.push(
        guardWatcher(
          watch(join(this.codexDir, "sessions"), { recursive: true }, () => onChange()),
          (msg) => this.log(`codex: ${msg}`),
        ),
      );
    } catch (err) {
      this.log(`codex: cannot watch sessions: ${String(err)}`);
    }
    try {
      watchers.push(
        guardWatcher(
          watch(this.codexDir, (_event, name) => {
            if (name === "session_index.jsonl") onChange();
          }),
          (msg) => this.log(`codex: ${msg}`),
        ),
      );
    } catch (err) {
      this.log(`codex: cannot watch codex dir: ${String(err)}`);
    }
    return { dispose: () => watchers.forEach((w) => w.close()) };
  }
}
