import { appendFile, mkdir, open, realpath, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Moving a session to another folder the way Claude Code does it when the
 * working directory of a session changes: the transcript and its sibling
 * directory (subagent transcripts, tool results) go to the project folder of
 * the new directory, and a "relocated" entry appended to the transcript
 * names that directory. Claude Code and the Agent SDK take the session's
 * working directory from the last such entry.
 */

/** Claude Code keeps longer names with a hash this module does not reproduce. */
const MAX_PROJECT_NAME = 200;

/** The name of the project folder Claude Code keeps the sessions of `cwd` in, undefined for a path too long to name. */
export function claudeProjectDirName(cwd: string): string | undefined {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= MAX_PROJECT_NAME ? name : undefined;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

async function endsWithNewline(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size === 0) return true;
    const { buffer } = await file.read(Buffer.alloc(1), 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await file.close();
  }
}

/**
 * Moves the transcript `source` of session `id` to the project folder of
 * the directory `cwd` under `projectsDir` and stamps it as relocated there.
 * Returns the directory as written to the transcript, with symlinks resolved.
 */
export async function relocateTranscript(projectsDir: string, source: string, id: string, cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error(`${JSON.stringify(cwd.slice(0, 200))} is not an absolute path`);
  let target: string;
  try {
    target = (await realpath(cwd)).normalize("NFC");
    if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${cwd} is not an existing folder`);
  }
  const name = claudeProjectDirName(target);
  if (!name) throw new Error(`the path of ${target} is too long to find its Claude Code project folder`);
  const targetDir = join(projectsDir, name);
  const dest = join(targetDir, `${id}.jsonl`);
  if (dest !== source) {
    const sourceExtras = join(dirname(source), id);
    const destExtras = join(targetDir, id);
    if ((await exists(dest)) || (await exists(destExtras))) throw new Error(`the project folder of ${target} already has a session with this id`);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await rename(source, dest);
    if (await exists(sourceExtras)) {
      try {
        await rename(sourceExtras, destExtras);
      } catch (err) {
        // Keep the transcript and its directory together.
        await rename(dest, source).catch(() => {});
        throw err;
      }
    }
  }
  const stamp = JSON.stringify({ type: "relocated", sessionId: id, relocatedCwd: target }) + "\n";
  await appendFile(dest, (await endsWithNewline(dest)) ? stamp : "\n" + stamp);
  return target;
}
