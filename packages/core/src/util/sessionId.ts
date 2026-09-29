/**
 * Whether `id` is a session UUID (8-4-4-4-12 hex digits, any case). Claude
 * Code and Codex both name sessions this way; anything else is refused
 * before it reaches an agent's own tools (a command line, the SDK).
 */
export function isValidSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
