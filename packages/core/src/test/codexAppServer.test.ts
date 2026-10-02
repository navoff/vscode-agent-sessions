import { test } from "node:test";
import assert from "node:assert/strict";
import { AppServerExitError, appServerRequest } from "../codex/appServer.js";

/**
 * Stands in for `codex app-server`: answers initialize, then handles one
 * request as `onRequest` (the body of `(msg, send) => {...}`) says. Like the
 * real server it exits as soon as stdin closes.
 */
function fakeServer(onRequest: string): string[] {
  const script = `
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    const seen = [];
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const msg = JSON.parse(line);
      seen.push(msg.method);
      if (msg.method === "initialize") {
        send({ method: "remoteControl/status/changed", params: { status: "disabled" } });
        send({ id: msg.id, result: { userAgent: "fake", client: msg.params.clientInfo.name } });
      } else if (msg.id !== undefined) {
        (${onRequest})(msg, send, seen);
      }
    }).on("close", () => process.exit(0));
  `;
  return ["-e", script];
}
const opts = { env: process.env, timeoutMs: 5000 };

test("appServerRequest initializes, sends one request and resolves with its result", async () => {
  const args = fakeServer(`(msg, send, seen) => {
    process.stdout.write("not json\\n");
    send({ method: "thread/name/updated", params: {} });
    send({ id: 99, result: "someone else's answer" });
    send({ id: msg.id, result: { method: msg.method, params: msg.params, seen } });
  }`);
  const result = await appServerRequest(process.execPath, args, "thread/name/set", { threadId: "t", name: "n" }, opts);
  assert.deepEqual(result, { method: "thread/name/set", params: { threadId: "t", name: "n" }, seen: ["initialize", "initialized", "thread/name/set"] });
});

test("appServerRequest rejects with the server's error message", async () => {
  const args = fakeServer(`(msg, send) => send({ id: msg.id, error: { code: -32600, message: "thread name must not be empty" } })`);
  await assert.rejects(appServerRequest(process.execPath, args, "thread/name/set", {}, opts), /^Error: thread name must not be empty$/);
});

test("appServerRequest reports an exit before the answer with the code and stderr", async () => {
  const args = fakeServer(`() => { process.stderr.write("boom\\n"); process.exit(3); }`);
  await assert.rejects(appServerRequest(process.execPath, args, "thread/name/set", {}, opts), (err: unknown) => {
    assert.ok(err instanceof AppServerExitError);
    assert.equal(err.exitCode, 3);
    assert.match(err.stderr, /boom/);
    return true;
  });
  // A process that never speaks the protocol, such as a shell that cannot find codex.
  await assert.rejects(appServerRequest(process.execPath, ["-e", "process.exit(127)"], "thread/name/set", {}, opts), (err: unknown) => {
    return err instanceof AppServerExitError && err.exitCode === 127;
  });
});

test("appServerRequest gives up after the timeout and stops the server", async () => {
  const args = fakeServer(`() => {}`);
  const started = Date.now();
  await assert.rejects(appServerRequest(process.execPath, args, "thread/name/set", {}, { env: process.env, timeoutMs: 300 }), /did not answer within 0 s/);
  assert.ok(Date.now() - started < 4000);
});

test("appServerRequest keeps ENOENT when the binary does not exist", async () => {
  await assert.rejects(appServerRequest("/nonexistent/codex-binary", ["app-server"], "thread/name/set", {}, opts), (err: unknown) => {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  });
});
