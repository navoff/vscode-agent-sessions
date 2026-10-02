export const FIRST_PROMPT_MAX = 200;

/**
 * The start of `text` for a tooltip: its line breaks kept, blank lines
 * dropped, runs of spaces collapsed, at most FIRST_PROMPT_MAX characters.
 * Undefined when nothing is left.
 */
export function normalizeFirstPrompt(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const lines = text
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l);
  const chars = Array.from(lines.join("\n"));
  if (chars.length === 0) return undefined;
  return chars.length > FIRST_PROMPT_MAX ? chars.slice(0, FIRST_PROMPT_MAX - 1).join("").trimEnd() + "…" : chars.join("");
}
