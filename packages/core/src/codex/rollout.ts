import { open, type FileHandle } from "node:fs/promises";
import type { SessionStatus } from "../types.js";

export interface CodexRolloutMeta {
  id: string;
  cwd: string;
  createdAt: number;
  isUserThread: boolean;
}

export interface CodexRolloutInfo {
  meta: CodexRolloutMeta;
  title?: string;
  status: SessionStatus;
}

const HEAD_BYTES = 2 * 1024 * 1024;
const TAIL_CHUNK_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;
const TITLE_MAX = 80;

// Ported from Codex History Viewer (MIT, (c) 2026 HizTam): service rollouts
// (guardian reviews, spawned subagents) carry an object `source` with a
// `subagent` field, a non-user `thread_source`, or a `parent_thread_id`.
export function isUserThreadPayload(p: Record<string, unknown>): boolean {
  if (typeof p.parent_thread_id === "string") return false;
  if (typeof p.source === "object" && p.source !== null) return false;
  if (typeof p.thread_source === "string") return p.thread_source === "user";
  return true;
}

export function parseRolloutMeta(firstLine: string): CodexRolloutMeta | undefined {
  let record: unknown;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const r = record as { type?: unknown; payload?: unknown };
  if (r.type !== "session_meta" || typeof r.payload !== "object" || r.payload === null) return undefined;
  const p = r.payload as Record<string, unknown>;
  if (typeof p.id !== "string") return undefined;
  const parsed = typeof p.timestamp === "string" ? Date.parse(p.timestamp) : NaN;
  return {
    id: p.id,
    cwd: typeof p.cwd === "string" ? p.cwd : "",
    createdAt: Number.isNaN(parsed) ? 0 : parsed,
    isUserThread: isUserThreadPayload(p),
  };
}

export function titleFromUserText(text: string): string | undefined {
  const t = text.trim();
  if (!t || t.startsWith("<") || t.startsWith("#")) return undefined;
  const line = t.split("\n")[0].trim();
  if (!line) return undefined;
  return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1) + "…" : line;
}

export function extractFirstPrompt(lines: Iterable<string>): string | undefined {
  for (const line of lines) {
    if (!line.includes('"role":"user"')) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = r as { type?: unknown; payload?: { role?: unknown; content?: unknown } };
    if (rec.type !== "response_item" || rec.payload?.role !== "user" || !Array.isArray(rec.payload.content)) continue;
    for (const c of rec.payload.content) {
      const text = (c as { text?: unknown })?.text;
      if (typeof text !== "string") continue;
      const title = titleFromUserText(text);
      if (title) return title;
    }
  }
  return undefined;
}

const STATUS_EVENT = /"type":"(task_started|task_complete|turn_aborted)"/;

function lastStatusEvent(text: string): string | undefined {
  let last: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"event_msg"')) continue;
    const m = STATUS_EVENT.exec(line);
    if (m) last = m[1];
  }
  return last;
}

export function statusFromTail(tail: string): SessionStatus {
  return lastStatusEvent(tail) === "task_started" ? "running" : "idle";
}

// Reads the file backwards in 64 KB chunks until a chunk holds a task event.
// The partial first line of each chunk is carried over to the next (earlier)
// chunk. The scan stops after TAIL_MAX_BYTES to bound the cost on huge files.
export async function readStatusBackwards(fh: FileHandle, size: number): Promise<SessionStatus> {
  const limit = Math.max(0, size - TAIL_MAX_BYTES);
  let end = size;
  let carry = Buffer.alloc(0);
  while (end > limit) {
    const start = Math.max(limit, end - TAIL_CHUNK_BYTES);
    const chunk = Buffer.alloc(end - start);
    await fh.read(chunk, 0, chunk.length, start);
    end = start;
    const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    let complete: Buffer;
    if (start === 0) {
      complete = buf;
      carry = Buffer.alloc(0);
    } else {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        carry = buf;
        continue;
      }
      carry = buf.subarray(0, nl);
      complete = buf.subarray(nl + 1);
    }
    const last = lastStatusEvent(complete.toString("utf8"));
    if (last) return last === "task_started" ? "running" : "idle";
  }
  return "idle";
}

export async function readRolloutInfo(filePath: string, size: number): Promise<CodexRolloutInfo | undefined> {
  const fh = await open(filePath, "r");
  try {
    const headLen = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const headText = head.toString("utf8");
    const nl = headText.indexOf("\n");
    const meta = parseRolloutMeta(nl === -1 ? headText : headText.slice(0, nl));
    if (!meta) return undefined;
    if (!meta.isUserThread) return { meta, status: "idle" };
    const headLines = headText.split("\n");
    if (headLen < size) headLines.pop();
    const title = extractFirstPrompt(headLines);
    return { meta, title, status: await readStatusBackwards(fh, size) };
  } finally {
    await fh.close();
  }
}
