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

// Rejects hosts that ssh would parse as an option or that cannot be a host.
export function isValidSshHost(host: string): boolean {
  if (!host || host.length > 255 || host.startsWith("-")) return false;
  return !/[\s\x00-\x1f\x7f]/.test(host);
}
