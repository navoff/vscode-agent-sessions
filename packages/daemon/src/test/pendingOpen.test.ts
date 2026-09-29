import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@agent-sessions/core";
import { clearPendingOpen, pendingOpenPath, readPendingOpen, writePendingOpen } from "../pendingOpen.js";

const session = (cwd: string): SessionInfo => ({ agent: "claude", id: "a", title: "a", cwd, createdAt: 1, updatedAt: 1, status: "idle" });

test("pendingOpenPath is fixed under home", () => {
  assert.equal(pendingOpenPath("/h"), "/h/.local/share/agent-sessions/pending-open.json");
});

test("write, read and clear a pending open", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-pending-"));
  await writePendingOpen(home, session(home), 1000);
  assert.deepEqual(await readPendingOpen(home), { session: session(home), at: 1000 });
  assert.match(await readFile(pendingOpenPath(home), "utf8"), /"at":1000/);
  await clearPendingOpen(home);
  assert.equal(await readPendingOpen(home), undefined);
  await clearPendingOpen(home); // missing file is fine
});

test("writing refuses a session whose folder is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-pending-"));
  await assert.rejects(writePendingOpen(home, session(join(home, "gone")), 1), /does not exist/);
  assert.equal(await readPendingOpen(home), undefined);
});

test("reading tolerates broken content", async () => {
  const home = await mkdtemp(join(tmpdir(), "as-pending-"));
  await writePendingOpen(home, session(home), 1);
  await writeFile(pendingOpenPath(home), "{not json");
  assert.equal(await readPendingOpen(home), undefined);
  await writeFile(pendingOpenPath(home), JSON.stringify({ session: { id: 1 }, at: "x" }));
  assert.equal(await readPendingOpen(home), undefined);
});
