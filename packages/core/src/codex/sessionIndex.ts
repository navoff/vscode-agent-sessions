import { readFile } from "node:fs/promises";

export async function readSessionIndex(filePath: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return titles;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof r.id === "string" && typeof r.thread_name === "string" && r.thread_name.trim()) {
        titles.set(r.id, r.thread_name.trim());
      }
    } catch {
      // skip malformed line
    }
  }
  return titles;
}
