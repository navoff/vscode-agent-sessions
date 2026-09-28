import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Ported from Codex History Viewer (MIT, (c) 2026 HizTam): rollout files are
// `rollout-<timestamp>-<id>.jsonl` under `~/.codex/sessions/<yyyy>/<mm>/<dd>`.
export async function listRolloutFiles(sessionsDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(sessionsDir);
  return out;
}
