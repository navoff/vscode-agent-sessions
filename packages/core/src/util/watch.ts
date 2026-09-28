import type { FSWatcher } from "node:fs";

/**
 * Attaches an `error` listener to an `FSWatcher` so an asynchronous watcher
 * error is logged instead of crashing the process (an unhandled `error`
 * event on an `EventEmitter` throws). Returns the same watcher for chaining.
 */
export function guardWatcher(w: FSWatcher, log: (msg: string) => void): FSWatcher {
  w.on("error", (err) => log(`watch error: ${String(err)}`));
  return w;
}
