import { spawnSync } from "node:child_process";

// The tray helper is optional at build time: without Go the extension builds
// without a tray, and says so.
const probe = spawnSync("go", ["version"], { stdio: "ignore" });
if (probe.status !== 0) {
  console.warn("build-tray: go not found, the tray helper is not built; the extension will have no system tray icon on Linux");
  process.exit(0);
}
const result = spawnSync("sh", ["../tray/build.sh"], { stdio: "inherit" });
process.exit(result.status ?? 1);
