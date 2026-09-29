import { homedir } from "node:os";
import { type DaemonProcess } from "./machineConnection.js";
import { ensureSharedDaemon, sharedDaemonPaths, socketDir, spawnDetachedDaemon, tailOfLog } from "./sharedDaemon.js";

/**
 * Connects to the machine-wide daemon over its unix socket, starting it when
 * needed. The returned process wrapper only owns the socket: killing it closes
 * the connection, never the shared daemon.
 */
export async function connectLocalDaemon(daemonPath: string, log: (line: string) => void): Promise<DaemonProcess> {
  const paths = sharedDaemonPaths(socketDir(process.env, homedir()));
  const socket = await ensureSharedDaemon({
    paths,
    log: (m) => log(`[local] ${m}`),
    spawnDaemon: () =>
      void spawnDetachedDaemon(daemonPath, paths.socket, paths.log, (err) => log(`[local] spawn error: ${String(err)}`)).catch(
        (err) => log(`[local] spawn failed: ${String(err)}`),
      ),
  });
  // connectSocket already keeps an error listener; this one only logs.
  socket.on("error", (err) => log(`[local] socket error: ${String(err)}`));
  let lastLog = "";
  return {
    stdin: socket,
    stdout: socket,
    kill: () => {
      socket.destroy();
    },
    onExit: (cb) => {
      const fire = () => {
        void tailOfLog(paths.log).then((t) => {
          lastLog = t;
          cb(null);
        });
      };
      if (socket.closed) fire();
      else socket.once("close", fire);
    },
    lastStderr: () => lastLog,
  };
}
