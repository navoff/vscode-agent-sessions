import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Disposable, SessionInfo, SessionProvider } from "../types.js";
import { guardWatcher } from "../util/watch.js";
import { listRolloutFiles } from "./discovery.js";
import { readRolloutInfo, type CodexRolloutInfo } from "./rollout.js";
import { readSessionIndex } from "./sessionIndex.js";

export interface CodexProviderOptions {
  codexDir?: string;
  log?: (msg: string) => void;
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

  constructor(opts: CodexProviderOptions = {}) {
    this.codexDir = opts.codexDir ?? join(homedir(), ".codex");
    this.log = opts.log ?? (() => {});
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
      const updatedAt = Math.trunc(st.mtimeMs);
      const existing = result.get(info.meta.id);
      if (existing && existing.updatedAt >= updatedAt) continue;
      result.set(info.meta.id, {
        agent: "codex",
        id: info.meta.id,
        title: titles.get(info.meta.id) ?? info.title ?? info.meta.id,
        cwd: info.meta.cwd,
        createdAt: info.meta.createdAt || updatedAt,
        updatedAt,
        status: info.status,
      });
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return [...result.values()];
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
