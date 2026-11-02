import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyValueStore } from "./marks.js";

type MarkValue = boolean | number | undefined;
interface LegacyMarks {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
}
interface Options {
  onChange?: () => void;
  onError?: (error: unknown) => void;
}

const isMarkKey = (key: string) => /^(hidden\/|pinned\/|seen\/|notified\/|hiddenProject\/|attention\/seeded$)/.test(key);
const isMarkValue = (value: unknown): value is MarkValue => value === undefined || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const filename = (key: string) => `${createHash("sha256").update(key).digest("hex")}.json`;

/**
 * Each key has its own atomic record: writing a read receipt cannot erase a
 * hide from another window. A record without a value is a tombstone, so a
 * stale globalState can never resurrect a mark the user removed.
 */
export class SharedMarksStore implements KeyValueStore {
  private readonly values = new Map<string, MarkValue>();
  private readonly writes = new Map<string, Promise<void>>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private revision = 0;
  private reloadGeneration = 0;
  private disposed = false;

  private constructor(private readonly dir: string, private readonly options: Options) {}

  static async open(dir: string, legacy: LegacyMarks, options: Options = {}): Promise<SharedMarksStore> {
    const store = new SharedMarksStore(dir, options);
    await mkdir(dir, { recursive: true });
    for (const key of legacy.keys()) {
      const value = legacy.get<unknown>(key);
      if (isMarkKey(key) && isMarkValue(value)) await store.writeRecord(key, value, true);
    }
    await store.reload();
    store.watcher = watch(dir, () => store.scheduleReload());
    store.watcher.on("error", (error) => options.onError?.(error));
    // Cover a write between the initial read and attaching the watcher.
    store.scheduleReload();
    return store;
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    if (!isMarkKey(key) || !isMarkValue(value)) throw new Error(`Invalid session mark: ${key}`);
    this.revision++;
    this.values.set(key, value);
    const previous = this.writes.get(key) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => this.writeRecord(key, value));
    this.writes.set(key, write);
    const result = write.then(async () => {
      if (this.writes.get(key) === write) this.writes.delete(key);
      this.scheduleReload();
    }, async (error) => {
      if (this.writes.get(key) === write) {
        this.writes.delete(key);
        // Roll back the optimistic value before telling the UI about the failure.
        this.values.delete(key);
        await this.reload().catch(() => undefined);
        this.options.onChange?.();
      }
      throw error;
    });
    // SessionMarks intentionally has a synchronous API. Handle its otherwise
    // unobserved rejection while still letting callers await a failed write.
    void result.catch((error) => this.options.onError?.(error));
    return result;
  }

  private async writeRecord(key: string, value: MarkValue, onlyIfMissing = false): Promise<void> {
    const target = join(this.dir, filename(key));
    const tmp = join(this.dir, `${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify({ key, value }));
      if (onlyIfMissing) {
        try {
          // Unlike rename, link publishes a complete file without replacing an
          // existing record, including another window's migration or tombstone.
          await link(tmp, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } else {
        await rename(tmp, target);
      }
    } finally {
      await unlink(tmp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  private scheduleReload(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reload().catch((error) => this.options.onError?.(error));
    }, 50);
  }

  private async reload(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.reloadGeneration;
    const revision = this.revision;
    const disk = new Map<string, MarkValue>();
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
      try {
        const record: unknown = JSON.parse(await readFile(join(this.dir, entry.name), "utf8"));
        if (typeof record !== "object" || record === null) throw new Error("expected an object");
        const { key, value } = record as { key?: unknown; value?: unknown };
        if (typeof key !== "string" || !isMarkKey(key) || !isMarkValue(value) || filename(key) !== entry.name) throw new Error("invalid record");
        disk.set(key, value);
      } catch (error) {
        throw new Error(`Cannot read session mark ${entry.name}`, { cause: error });
      }
    }
    // Watcher bursts can start overlapping reads. Once a newer read started,
    // an older snapshot must never replace its result in this window.
    if (this.disposed || generation !== this.reloadGeneration) return;
    if (revision !== this.revision) {
      this.scheduleReload();
      return;
    }
    let changed = false;
    for (const key of new Set([...this.values.keys(), ...disk.keys()])) {
      if (this.writes.has(key)) continue;
      const value = disk.get(key);
      if (this.values.get(key) !== value) changed = true;
      if (value === undefined) this.values.delete(key);
      else this.values.set(key, value);
    }
    if (changed) this.options.onChange?.();
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }
}
