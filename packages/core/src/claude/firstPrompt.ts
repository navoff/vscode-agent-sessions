import { open } from "node:fs/promises";

const HEAD_BYTES = 2 * 1024 * 1024;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The user message in a piece of transcript jsonl that the SDK's
 * `firstPrompt` was made from. The SDK puts the prompt on one line; the
 * message still has its line breaks.
 */
export function findPromptText(headText: string, sdkFirstPrompt: string): string | undefined {
  const key = collapse(sdkFirstPrompt.replace(/(…|\.\.\.)$/, ""));
  if (!key) return undefined;
  for (const line of headText.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    let rec: { type?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial or garbage line
    }
    if (rec.type !== "user" || rec.isMeta === true || rec.isSidechain === true) continue;
    const content = rec.message?.content;
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map((b) => (b as { type?: unknown; text?: unknown })?.type === "text" ? (b as { text?: unknown }).text : undefined) : [];
    for (const text of texts) {
      if (typeof text === "string" && collapse(text).startsWith(key)) return text;
    }
  }
  return undefined;
}

/** Reads the head of a session file and finds the first prompt in it; see findPromptText. */
export async function readPromptText(filePath: string, sdkFirstPrompt: string, maxBytes = HEAD_BYTES): Promise<string | undefined> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return findPromptText(buf.toString("utf8", 0, bytesRead), sdkFirstPrompt);
  } finally {
    await fh.close();
  }
}
