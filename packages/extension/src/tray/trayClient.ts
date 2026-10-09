import { join, normalize } from "node:path";
import { socketDir } from "../connection/sharedDaemon.js";

const CLI_NAMES: Record<string, string> = { vscode: "code", "vscode-insiders": "code-insiders", vscodium: "codium" };

/**
 * The CLI wrapper of this VS Code build (<root>/bin/code), found from
 * vscode.env.appRoot (<root>/resources/app); undefined when the scheme is not
 * a known build or the file is missing.
 */
export function vscodeCliPath(appRoot: string, scheme: string, exists: (p: string) => boolean): string | undefined {
  const name = Object.hasOwn(CLI_NAMES, scheme) ? CLI_NAMES[scheme] : undefined;
  if (name === undefined) return undefined;
  const path = normalize(join(appRoot, "..", "..", "bin", name));
  return exists(path) ? path : undefined;
}

export interface TraySession {
  machine: string;
  machineName: string;
  agent: string;
  id: string;
  title: string;
}

export interface TrayState {
  scheme: string;
  /** The `code` CLI of this VS Code build, which the helper uses to open URIs. */
  cli?: string;
  sessions: TraySession[];
}

export interface TrayNotification {
  title: string;
  body: string;
  /** The session a click opens; absent for a summary, whose click shows the view. */
  session?: { machine: string; agent: string; id: string };
  /** Absolute path of an icon file shown beside the title, such as the agent icon of the tree. */
  icon?: string;
}

export type TrayMessage = ({ type: "state" } & TrayState) | ({ type: "notify" } & TrayNotification);

export interface TraySocket {
  write(line: string): void;
  onClose(cb: () => void): void;
  end(): void;
}

export interface TrayClientOptions {
  socketPath: string;
  /** Undefined on a platform or architecture without a helper. */
  binaryPath: string | undefined;
  connect(path: string): Promise<TraySocket>;
  spawn(binary: string, socketPath: string): Promise<void>;
  log(line: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export const RETRY_INTERVAL_MS = 60_000;
const SPAWN_ATTEMPTS = 20;
const SPAWN_ATTEMPT_GAP_MS = 100;

export function encodeTrayMessage(msg: TrayMessage): string {
  return JSON.stringify(msg) + "\n";
}

/** Next to the shared daemon's socket, in the same private directory. */
export function traySocketPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(socketDir(env, home), "tray.sock");
}

export function trayBinaryPath(extensionPath: string, platform: string, arch: string): string | undefined {
  if (platform !== "linux") return undefined;
  const goarch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!goarch) return undefined;
  return join(extensionPath, "dist", "tray", `linux-${goarch}`, "agent-sessions-tray");
}

/**
 * The window's end of the tray helper: one helper per machine, started by
 * whichever window finds none, fed the full attention list by every window.
 * Failures are logged once and retried at most once a minute.
 */
export class TrayClient {
  private socket: TraySocket | undefined;
  private lastState: TrayState | undefined;
  /** The last state line written to the current socket. */
  private sentStateLine: string | undefined;
  private enabled = true;
  private connecting: Promise<void> | undefined;
  private lastAttempt = -Infinity;
  private failureLogged = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: TrayClientOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) this.lastAttempt = -Infinity;
    this.enabled = enabled;
    if (!enabled) this.drop(true);
  }

  /** Remembers the state, connects when needed and sends it; resolves once the attempt is over. */
  async setState(state: TrayState): Promise<void> {
    this.lastState = state;
    if (!this.enabled || !this.opts.binaryPath) return;
    if (this.socket) {
      this.sendState();
      return;
    }
    await this.ensureConnected();
  }

  /** Sends a notification; false when no helper is connected, so the caller shows its own. */
  notify(n: TrayNotification): boolean {
    if (!this.socket) return false;
    this.send({ type: "notify", ...n });
    return true;
  }

  dispose(): void {
    this.enabled = false;
    this.drop(true);
  }

  /** Sends the last state unless the current socket already has it. */
  private sendState(): void {
    if (!this.lastState) return;
    const line = encodeTrayMessage({ type: "state", ...this.lastState });
    if (line === this.sentStateLine) return;
    if (this.write(line)) this.sentStateLine = line;
  }

  private send(msg: TrayMessage): void {
    this.write(encodeTrayMessage(msg));
  }

  private write(line: string): boolean {
    if (!this.socket) return false;
    try {
      this.socket.write(line);
      return true;
    } catch (err) {
      this.opts.log(`[tray] write failed: ${String(err)}`);
      this.drop(false);
      return false;
    }
  }

  private drop(end: boolean): void {
    const s = this.socket;
    this.socket = undefined;
    this.sentStateLine = undefined;
    if (s && end) {
      try {
        s.end();
      } catch {
        // already gone
      }
    }
  }

  private ensureConnected(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.now() - this.lastAttempt < RETRY_INTERVAL_MS) return Promise.resolve();
    this.lastAttempt = this.now();
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async tryConnect(): Promise<TraySocket | undefined> {
    try {
      return await this.opts.connect(this.opts.socketPath);
    } catch {
      return undefined;
    }
  }

  private async connectOnce(): Promise<void> {
    let socket = await this.tryConnect();
    if (!socket) {
      try {
        await this.opts.spawn(this.opts.binaryPath!, this.opts.socketPath);
      } catch (err) {
        this.logFailure(`cannot start the tray helper: ${String(err)}`);
        return;
      }
      for (let i = 0; i < SPAWN_ATTEMPTS && !socket; i++) {
        await this.sleep(SPAWN_ATTEMPT_GAP_MS);
        socket = await this.tryConnect();
      }
    }
    if (!socket) {
      this.logFailure("the tray helper did not come up; using the badge and VS Code messages instead");
      return;
    }
    if (!this.enabled) {
      socket.end();
      return;
    }
    this.socket = socket;
    this.sentStateLine = undefined;
    this.failureLogged = false;
    socket.onClose(() => {
      if (this.socket === socket) this.drop(false);
    });
    this.sendState();
  }

  private logFailure(message: string): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    this.opts.log(`[tray] ${message}`);
  }
}
