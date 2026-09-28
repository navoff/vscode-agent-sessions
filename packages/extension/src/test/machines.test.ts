import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSshConfigHosts } from "../machines/sshConfig.js";
import { addMachine, parseMachinesFile, parseMachinesFileStrict, readMachinesFile, removeMachine, serializeMachinesFile, updateMachine, writeMachinesFile } from "../machines/machinesFile.js";

test("parseSshConfigHosts returns concrete hosts in order without duplicates", () => {
  const text = `
# comment
Host hetzner
  HostName 1.2.3.4
Host *.example.com !bastion
Host dev build
Host hetzner
Match host x
host lower
`;
  assert.deepEqual(parseSshConfigHosts(text), ["hetzner", "dev", "build", "lower"]);
});

test("parseMachinesFile tolerates garbage and fills defaults", () => {
  assert.deepEqual(parseMachinesFile("nope"), { version: 1, machines: [] });
  const f = parseMachinesFile(JSON.stringify({ version: 1, machines: [{ id: "a", sshHost: "a" }, { bad: true }] }));
  assert.deepEqual(f.machines, [{ id: "a", name: "a", sshHost: "a", enabled: true, autoConnect: false }]);
});

test("addMachine, updateMachine, removeMachine are pure", () => {
  let f = parseMachinesFile("");
  f = addMachine(f, "hetzner");
  f = addMachine(f, "hetzner", "second");
  assert.deepEqual(f.machines.map((m) => m.id), ["hetzner", "hetzner-2"]);
  assert.equal(f.machines[1].name, "second");
  f = updateMachine(f, "hetzner", { enabled: false, remoteNode: "/n" });
  assert.equal(f.machines[0].enabled, false);
  assert.equal(f.machines[0].remoteNode, "/n");
  f = removeMachine(f, "hetzner-2");
  assert.equal(f.machines.length, 1);
});

test("write then read round-trips and creates directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machines-"));
  const path = join(dir, "sub", "machines.json");
  const f = addMachine(parseMachinesFile(""), "hz");
  await writeMachinesFile(path, f);
  assert.deepEqual(await readMachinesFile(path), f);
  assert.equal(await readFile(path, "utf8"), serializeMachinesFile(f));
  assert.deepEqual(await readMachinesFile(join(dir, "missing.json")), { version: 1, machines: [] });
});

test("writeMachinesFile removes its tmp file when the rename fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machines-"));
  const path = join(dir, "machines.json");
  await mkdir(path);
  const f = addMachine(parseMachinesFile(""), "hz");
  await assert.rejects(() => writeMachinesFile(path, f));
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["machines.json"]);
});

test("parseMachinesFileStrict rejects invalid JSON and a missing machines array", () => {
  assert.equal(parseMachinesFileStrict("{ nope"), undefined);
  assert.equal(parseMachinesFileStrict("{}"), undefined);
  assert.equal(parseMachinesFileStrict('{"machines": 3}'), undefined);
  assert.deepEqual(parseMachinesFileStrict(JSON.stringify({ version: 1, machines: [{ id: "a", sshHost: "a" }] })), {
    version: 1,
    machines: [{ id: "a", name: "a", sshHost: "a", enabled: true, autoConnect: false }],
  });
});

test("readMachinesFile tells a missing file from an invalid one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machines-"));
  assert.deepEqual(await readMachinesFile(join(dir, "missing.json")), { version: 1, machines: [] });
  const bad = join(dir, "bad.json");
  await writeFile(bad, '{"machines": [ {"id": "a",');
  assert.equal(await readMachinesFile(bad), undefined);
  const schema = join(dir, "schema.json");
  await writeFile(schema, '{"version": 1}');
  assert.equal(await readMachinesFile(schema), undefined);
});
