/**
 * Whether `id` is safe to pass to an agent's own tools (a command line, the
 * SDK). Session ids are UUIDs; a leading "-" would read as an option.
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && !id.startsWith("-");
}
