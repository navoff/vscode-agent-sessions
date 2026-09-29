import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Timestamp of the last `user` or `assistant` record in a piece of jsonl text.
 * Claude Code also appends bookkeeping records (last-prompt, cost-state, ...)
 * when a tab is opened or closed; those must not count as activity.
 */
export function lastMessageTimestamp(tailText: string): number | undefined {
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"timestamp"')) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    try {
      const rec = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
      if ((rec.type === "user" || rec.type === "assistant") && typeof rec.timestamp === "string") {
        const ts = Date.parse(rec.timestamp);
        if (Number.isFinite(ts)) return ts;
      }
    } catch {
      // partial or garbage line
    }
  }
  return undefined;
}

/** Reads the tail of a session file (attachment records can be hundreds of KB). */
export async function readLastMessageTimestamp(
  filePath: string,
  size: number,
  maxBytes = 512 * 1024,
): Promise<number | undefined> {
  const length = Math.min(size, maxBytes);
  if (length <= 0) return undefined;
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, size - length);
    let text = buf.toString("utf8", 0, bytesRead);
    if (size > maxBytes) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return lastMessageTimestamp(text);
  } finally {
    await fh.close();
  }
}

/** Maps session id to its jsonl path for every `<projectsDir>/<project>/<id>.jsonl`. */
export async function indexSessionFiles(projectsDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return index;
  }
  for (const project of projects) {
    const dir = join(projectsDir, project);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) index.set(e.name.slice(0, -".jsonl".length), join(dir, e.name));
    }
  }
  return index;
}
