export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshRunner {
  run(host: string, command: string, stdin?: string): Promise<SshResult>;
}

export const NODE_VERSION = "22.15.0";
export const REMOTE_DIR_NAME = ".local/share/agent-sessions";
const MIN_NODE_MAJOR = 20;

export interface RemotePlatform {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
}

export interface PrepareResult {
  remoteNode: string;
  daemonVersion: string;
  remoteHome: string;
}

export type PrepareProgress = (step: string) => void;

export function resolvePlatform(uname: string): RemotePlatform | undefined {
  const [sys, machine] = uname.trim().split(/\s+/);
  const os = sys === "Linux" ? "linux" : sys === "Darwin" ? "darwin" : undefined;
  const arch = machine === "x86_64" ? "x64" : machine === "aarch64" || machine === "arm64" ? "arm64" : undefined;
  return os && arch ? { os, arch } : undefined;
}

export function isNodeVersionSupported(version: string): boolean {
  const major = Number.parseInt(version.trim().replace(/^v/, "").split(".")[0], 10);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

export function remoteDaemonPath(remoteHome: string): string {
  return `${remoteHome}/${REMOTE_DIR_NAME}/daemon.mjs`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function step(name: string, progress: PrepareProgress, ssh: SshRunner, host: string, command: string, stdin?: string): Promise<string> {
  progress(name);
  const r = await ssh.run(host, command, stdin);
  if (r.code !== 0) throw new Error(`${name} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || "no output"}`);
  return r.stdout;
}

async function nodeVersionAt(ssh: SshRunner, host: string, nodePath: string): Promise<string | undefined> {
  const r = await ssh.run(host, `${nodePath} -p process.versions.node`);
  return r.code === 0 && isNodeVersionSupported(r.stdout) ? nodePath : undefined;
}

export async function prepareMachine(host: string, ssh: SshRunner, daemonSource: string, progress: PrepareProgress): Promise<PrepareResult> {
  const uname = await step("Checking platform", progress, ssh, host, "uname -sm");
  const platform = resolvePlatform(uname);
  if (!platform) throw new Error(`Unsupported remote platform: ${uname.trim()}`);

  const remoteHome = (await step("Resolving home", progress, ssh, host, "echo $HOME")).trim();
  const dir = `${remoteHome}/${REMOTE_DIR_NAME}`;

  progress("Looking for Node");
  let node = await nodeVersionAt(ssh, host, `${dir}/node/bin/node`);
  if (!node) {
    const found = await ssh.run(host, "bash -lc 'command -v node'");
    const candidate = found.stdout.trim();
    if (found.code === 0 && candidate) node = await nodeVersionAt(ssh, host, candidate);
  }
  if (!node) {
    const name = `node-v${NODE_VERSION}-${platform.os}-${platform.arch}`;
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`;
    await step(
      "Downloading Node",
      progress,
      ssh,
      host,
      `mkdir -p ${shellQuote(dir)} && cd ${shellQuote(dir)} && rm -rf node ${name} && ` +
        `{ command -v curl >/dev/null 2>&1 && curl -fsSL ${url} || wget -qO- ${url}; } | tar -xz && mv ${name} node`,
    );
    node = `${dir}/node/bin/node`;
  }

  await step("Copying daemon", progress, ssh, host, `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(remoteDaemonPath(remoteHome))}`, daemonSource);
  const version = await step("Verifying daemon", progress, ssh, host, `${node} ${remoteDaemonPath(remoteHome)} --version`);
  return { remoteNode: node, daemonVersion: version.trim(), remoteHome };
}
