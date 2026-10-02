export const MAX_SESSION_TITLE_LENGTH = 200;

/**
 * Why `title`, already trimmed, cannot name a session; undefined when it
 * can. The same rule is checked where the title is typed and again before
 * it reaches an agent's own tools (the SDK, the Codex app server).
 */
export function sessionTitleProblem(title: string): string | undefined {
  if (!title) return "session title is empty";
  if (title.length > MAX_SESSION_TITLE_LENGTH) return `session title is longer than ${MAX_SESSION_TITLE_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(title)) return "session title must be a single line without control characters";
  return undefined;
}

/** `title` trimmed; throws when it cannot name a session. */
export function normalizeSessionTitle(title: string): string {
  const trimmed = title.trim();
  const problem = sessionTitleProblem(trimmed);
  if (problem) throw new Error(problem);
  return trimmed;
}
