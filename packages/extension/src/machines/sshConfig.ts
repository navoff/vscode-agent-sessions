export function parseSshConfigHosts(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^host\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const token of m[1].split(/\s+/)) {
      if (!token || token.includes("*") || token.includes("?") || token.startsWith("!")) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      hosts.push(token);
    }
  }
  return hosts;
}
