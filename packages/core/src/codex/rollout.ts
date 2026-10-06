import { open, type FileHandle } from "node:fs/promises";
import type { SessionStatus } from "../types.js";
import { normalizeFirstPrompt } from "../util/firstPrompt.js";

export interface CodexRolloutMeta {
  id: string;
  cwd: string;
  createdAt: number;
  isUserThread: boolean;
}

export interface CodexRolloutInfo {
  meta: CodexRolloutMeta;
  title?: string;
  /** The start of the first user message, longer than the title. */
  firstPrompt?: string;
  status: SessionStatus;
  /** Timestamp of the last message or task event; undefined when none was found in the tail. */
  activityAt?: number;
  /** The working directory Codex last recorded, when it is not the one the thread started in. */
  cwd?: string;
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
  const text = extractFirstUserText(lines);
  return text === undefined ? undefined : titleFromUserText(text);
}

/** The whole text of the first user message that can give a title. */
export function extractFirstUserText(lines: Iterable<string>): string | undefined {
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
      if (titleFromUserText(text)) return text;
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

/**
 * The working directory a record sets: Codex writes it with the settings of
 * a thread it loads (thread_settings_applied) and with every turn
 * (turn_context). A thread resumed in another directory has a later one
 * than its session_meta.
 */
function cwdOf(line: string): string | undefined {
  const settings = line.includes('"thread_settings_applied"');
  if (!settings && !line.includes('"turn_context"')) return undefined;
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return undefined;
  }
  const rec = r as { type?: unknown; payload?: { type?: unknown; cwd?: unknown; thread_settings?: { cwd?: unknown } } } | null;
  let cwd: unknown;
  if (rec?.type === "turn_context") cwd = rec.payload?.cwd;
  else if (rec?.type === "event_msg" && rec.payload?.type === "thread_settings_applied") cwd = rec.payload.thread_settings?.cwd;
  return typeof cwd === "string" && cwd ? cwd : undefined;
}

interface TailScan {
  status?: string;
  /** The last working directory recorded in the block. */
  cwd?: string;
  activityAt?: number;
  /** Last event of any kind except thread_settings_applied: shows the agent loop is alive. */
  lastEventAt?: number;
}

/** Last task event and last activity timestamp within one block of complete lines. */
function scanTail(text: string): TailScan {
  const out: TailScan = {};
  for (const line of text.split("\n")) {
    out.cwd = cwdOf(line) ?? out.cwd;
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

// Reads the file backwards in 64 KB chunks until a task event, an activity
// time and a working directory are found.
// The partial first line of each chunk is carried over to the next (earlier)
// chunk. The scan stops after TAIL_MAX_BYTES to bound the cost on huge files.
/** A turn that has written nothing for this long is treated as abandoned, not running. */
export const STALE_RUNNING_MS = 30 * 60 * 1000;

export async function readTailBackwards(
  fh: FileHandle,
  size: number,
  now: number = Date.now(),
): Promise<{ status: SessionStatus; activityAt?: number; cwd?: string }> {
  const limit = Math.max(0, size - TAIL_MAX_BYTES);
  let end = size;
  let carry = Buffer.alloc(0);
  let status: string | undefined;
  let activityAt: number | undefined;
  let lastEventAt: number | undefined;
  let cwd: string | undefined;
  while (end > limit && (status === undefined || activityAt === undefined || cwd === undefined)) {
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
    if (cwd === undefined && scan.cwd !== undefined) cwd = scan.cwd;
  }
  const alive = lastEventAt === undefined || now - lastEventAt < STALE_RUNNING_MS;
  return { status: status === "task_started" && alive ? "running" : "idle", activityAt, cwd };
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
    const text = extractFirstUserText(headLines);
    const tail = await readTailBackwards(fh, size, now);
    const info: CodexRolloutInfo = { meta, title: text === undefined ? undefined : titleFromUserText(text), status: tail.status, activityAt: tail.activityAt };
    const firstPrompt = normalizeFirstPrompt(text);
    if (firstPrompt) info.firstPrompt = firstPrompt;
    if (tail.cwd !== undefined && tail.cwd !== meta.cwd) info.cwd = tail.cwd;
    return info;
  } finally {
    await fh.close();
  }
}
