import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLockHolder, lockHolderFromProcLocks } from "../util/fileLock.js";

// dev 64513 = 0xfc01 -> major fc, minor 01 (as seen on a real machine).
const LOCKS = [
  "1: POSIX  ADVISORY  WRITE 111 fc:01:42 0 EOF",
  "224: FLOCK  ADVISORY  WRITE 601322 fc:01:9966635 0 EOF",
  "224: -> FLOCK  ADVISORY  WRITE 777 fc:01:9966635 0 EOF",
  "",
].join("\n");

test("lockHolderFromProcLocks matches device and inode", () => {
  assert.equal(lockHolderFromProcLocks(LOCKS, 64513, 9966635), 601322);
  assert.equal(lockHolderFromProcLocks(LOCKS, 64513, 42), 111);
  assert.equal(lockHolderFromProcLocks(LOCKS, 64514, 9966635), undefined);
  assert.equal(lockHolderFromProcLocks(LOCKS, 64513, 1), undefined);
  assert.equal(lockHolderFromProcLocks("garbage\n", 64513, 1), undefined);
});

test("lockHolderFromProcLocks decodes large minor numbers", () => {
  // major 0x103, minor 0x12345: dev = (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12)
  const dev = 0x45 | (0x103 << 8) | ((0x12345 & ~0xff) << 12);
  assert.equal(lockHolderFromProcLocks("5: FLOCK ADVISORY WRITE 9 103:12345:7 0 EOF", dev, 7), 9);
});

test("fileLockHolder reads a locks file and tolerates missing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lock-"));
  const file = join(dir, "t.lock");
  await writeFile(file, "");
  const st = await stat(file);
  const major = (Math.floor(st.dev / 256) & 0xfff).toString(16);
  const minor = ((st.dev & 0xff) | (Math.floor(st.dev / 4096) & 0xfff00)).toString(16);
  const locks = join(dir, "locks");
  await writeFile(locks, `3: FLOCK  ADVISORY  WRITE 4242 ${major}:${minor}:${st.ino} 0 EOF\n`);
  assert.equal(await fileLockHolder(file, locks), 4242);
  assert.equal(await fileLockHolder(join(dir, "missing.lock"), locks), undefined);
  assert.equal(await fileLockHolder(file, join(dir, "no-proc-locks")), undefined);
});
