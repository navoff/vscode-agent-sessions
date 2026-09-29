// Decides whether this window may replace the shared local daemon. A window
// replaces only a daemon older than itself: killing a newer one (started by
// an updated window) would make the windows restart each other in turn.

/** What to do about a running daemon that differs from this window's. */
export type DaemonAction =
  /** Same as ours: nothing to do. */
  | "keep"
  /** Older than ours (or not comparable in order, see below): replace it. */
  | "restart"
  /** Newer than ours: leave it, this window should be reloaded or updated. */
  | "newer";

interface Semver {
  core: [number, number, number];
  pre: string[];
}

function parseSemver(v: string): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
  // A release is newer than any of its prereleases.
  if (a.length === 0 || b.length === 0) return (a.length === 0 ? 1 : 0) - (b.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y) < 0 ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Semver order of `a` and `b` (-1, 0, 1), build metadata ("+hash") ignored;
 * undefined when either is not a version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  const p = comparePre(x.pre, y.pre);
  return p < 0 ? -1 : p > 0 ? 1 : 0;
}

/**
 * For a running daemon version such as "0.1.0+f3f7bc4d5c6e" against the
 * bundled one. Builds of the same version (differing only after "+") cannot
 * be ordered; those, like an unreadable running version, are replaced, as
 * before versions were compared.
 */
export function daemonVersionAction(running: string, bundled: string): DaemonAction {
  if (running === bundled) return "keep";
  const order = compareVersions(running, bundled);
  return order === 1 ? "newer" : "restart";
}

/** M from the daemon's "unsupported protocol N, daemon speaks M". */
export function parseDaemonProtocol(message: string | undefined): number | undefined {
  const m = message === undefined ? null : /\bdaemon speaks (\d+)\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/**
 * For a protocol mismatch reported by the daemon. A message without the
 * daemon's protocol leaves the daemon alone: only a known older one is
 * replaced.
 */
export function protocolMismatchAction(message: string | undefined, ours: number): DaemonAction | undefined {
  const theirs = parseDaemonProtocol(message);
  if (theirs === undefined) return undefined;
  if (theirs < ours) return "restart";
  if (theirs > ours) return "newer";
  return "keep";
}
