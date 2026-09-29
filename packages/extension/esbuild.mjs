import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const daemonPkg = JSON.parse(readFileSync("../daemon/package.json", "utf8"));

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
  define: { __DAEMON_VERSION__: JSON.stringify(daemonPkg.version) },
});
copyFileSync("../daemon/dist/daemon.mjs", "dist/daemon.mjs");
