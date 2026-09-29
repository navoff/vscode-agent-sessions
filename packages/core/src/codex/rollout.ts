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
  /** Timestamp of the last message or task event; undefined when none was found in the tail. */
  activityAt?: number;
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
const MESSAGE_ROLE = /"role":"(user|assistant)"/;
const TIMESTAMP = /"timestamp":"([^"]+)"/;

/**
 * Activity records are user/assistant messages and task events. Codex also
 * appends bookkeeping events (thread_settings_applied, token_count) when a
 * thread is merely opened; those must not count as activity.
 */
function isActivityLine(line: string): boolean {
  if (line.includes('"event_msg"')) return STATUS_EVENT.test(line);
  return line.includes('"response_item"') && line.includes('"type":"message"') && MESSAGE_ROLE.test(line);
}

function timestampOf(line: string): number | undefined {
  const m = TIMESTAMP.exec(line);
  if (!m) return undefined;
  const ts = Date.parse(m[1]);
  return Number.isFinite(ts) ? ts : undefined;
}

interface TailScan {
  status?: string;
  activityAt?: number;
  /** Last event of any kind except thread_settings_applied: shows the agent loop is alive. */
  lastEventAt?: number;
}

/** Last task event and last activity timestamp within one block of complete lines. */
function scanTail(text: string): TailScan {
  const out: TailScan = {};
  for (const line of text.split("\n")) {
    if (line.includes('"event_msg"')) {
      if (!line.includes('"thread_settings_applied"')) out.lastEventAt = timestampOf(line) ?? out.lastEventAt;
      const m = STATUS_EVENT.exec(line);
      if (m) {
        out.status = m[1];
        out.activityAt = timestampOf(line) ?? out.activityAt;
      }
      continue;
    }
    if (isActivityLine(line)) out.activityAt = timestampOf(line) ?? out.activityAt;
  }
  return out;
}

function lastStatusEvent(text: string): string | undefined {
  return scanTail(text).status;
}

export function statusFromTail(tail: string): SessionStatus {
  return lastStatusEvent(tail) === "task_started" ? "running" : "idle";
}

// Reads the file backwards in 64 KB chunks until a chunk holds a task event.
// The partial first line of each chunk is carried over to the next (earlier)
// chunk. The scan stops after TAIL_MAX_BYTES to bound the cost on huge files.
/** A turn that has written nothing for this long is treated as abandoned, not running. */
export const STALE_RUNNING_MS = 30 * 60 * 1000;

export async function readTailBackwards(
  fh: FileHandle,
  size: number,
  now: number = Date.now(),
): Promise<{ status: SessionStatus; activityAt?: number }> {
  const limit = Math.max(0, size - TAIL_MAX_BYTES);
  let end = size;
  let carry = Buffer.alloc(0);
  let status: string | undefined;
  let activityAt: number | undefined;
  let lastEventAt: number | undefined;
  while (end > limit && (status === undefined || activityAt === undefined)) {
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
    const scan = scanTail(complete.toString("utf8"));
    // Chunks are visited from the end, so the first hit is the latest one.
    if (status === undefined && scan.status !== undefined) status = scan.status;
    if (activityAt === undefined && scan.activityAt !== undefined) activityAt = scan.activityAt;
    if (lastEventAt === undefined && scan.lastEventAt !== undefined) lastEventAt = scan.lastEventAt;
  }
  const alive = lastEventAt === undefined || now - lastEventAt < STALE_RUNNING_MS;
  return { status: status === "task_started" && alive ? "running" : "idle", activityAt };
}

export async function readStatusBackwards(fh: FileHandle, size: number): Promise<SessionStatus> {
  return (await readTailBackwards(fh, size)).status;
}

export async function readRolloutInfo(filePath: string, size: number, now: number = Date.now()): Promise<CodexRolloutInfo | undefined> {
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
    const tail = await readTailBackwards(fh, size, now);
    return { meta, title, status: tail.status, activityAt: tail.activityAt };
  } finally {
    await fh.close();
  }
}
