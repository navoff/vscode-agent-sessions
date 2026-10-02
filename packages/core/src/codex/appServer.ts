import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** The app server exited before it answered; `exitCode` is null when it was killed. */
export class AppServerExitError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`codex app-server exited (${exitCode === null ? "killed" : `exit ${exitCode}`}) before answering`);
  }
}

/**
 * Starts `file args` as a Codex app server on stdio, sends it one request
 * and resolves with the result. Rejects with the server's error message,
 * with AppServerExitError when the process ends first, on a timeout, or
 * with the spawn error (it keeps its `code`, such as "ENOENT").
 */
export type AppServerRequest = (
  file: string,
  args: string[],
  method: string,
  params: unknown,
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<unknown>;

const INITIALIZE_ID = 1;
const REQUEST_ID = 2;
const STDERR_LIMIT = 4000;

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : JSON.stringify(error);
}

export const appServerRequest: AppServerRequest = (file, args, method, params, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stderr = "";
    // The server exits as soon as stdin closes, answered or not, so stdin
    // stays open until the answer and the process is stopped after it.
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`codex app-server did not answer within ${Math.round(opts.timeoutMs / 1000)} s`))),
      opts.timeoutMs,
    );
    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => finish(() => reject(new AppServerExitError(code, stderr))));
    // A write to a server that is already gone; "close" reports the exit.
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += String(chunk);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg: { id?: unknown; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      // Notifications and anything else without our ids are not for us.
      if (msg.id === INITIALIZE_ID) {
        if (msg.error !== undefined) return finish(() => reject(new Error(`codex app-server refused initialize: ${errorMessage(msg.error)}`)));
        send({ method: "initialized" });
        send({ id: REQUEST_ID, method, params });
      } else if (msg.id === REQUEST_ID) {
        if (msg.error !== undefined) finish(() => reject(new Error(errorMessage(msg.error))));
        else finish(() => resolve(msg.result));
      }
    });
    send({ id: INITIALIZE_ID, method: "initialize", params: { clientInfo: { name: "agent-sessions", title: "Agent Sessions", version: "1" } } });
  });
