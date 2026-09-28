import { open } from "node:fs/promises";
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
const TAIL_BYTES = 64 * 1024;
const TITLE_MAX = 80;

// Ported from Codex History Viewer (MIT, (c) 2026 HizTam): service rollouts
// (guardian reviews, spawned subagents) carry an object `source` with a
// `subagent` field, a non-user `thread_source`, or a `parent_thread_id`.
export function isUserThreadPayload(p: Record<string, unknown>): boolean {
  if (typeof p.thread_source === "string") return p.thread_source === "user";
  if (typeof p.parent_thread_id === "string") return false;
  return typeof p.source !== "object" || p.source === null;
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

export function statusFromTail(tail: string): SessionStatus {
  let last: string | undefined;
  for (const line of tail.split("\n")) {
    if (!line.includes('"event_msg"')) continue;
    const m = STATUS_EVENT.exec(line);
    if (m) last = m[1];
  }
  return last === "task_started" ? "running" : "idle";
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
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tailLen = size - tailStart;
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, tailStart);
    return { meta, title, status: statusFromTail(tail.toString("utf8")) };
  } finally {
    await fh.close();
  }
}
