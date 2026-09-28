import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { guardWatcher } from "../util/watch.js";

test("guardWatcher logs watcher errors instead of letting them throw", () => {
  const fake = new EventEmitter() as unknown as FSWatcher;
  const logs: string[] = [];
  const returned = guardWatcher(fake, (msg) => logs.push(msg));
  assert.equal(returned, fake);
  assert.doesNotThrow(() => (fake as unknown as EventEmitter).emit("error", new Error("boom")));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /watch error/);
  assert.match(logs[0], /boom/);
});
