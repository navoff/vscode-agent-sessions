// Draws the tray menu with the sessions of the demo data as an SVG, and as a
// PNG when inkscape is available: media/tray-menu.svg and media/tray-menu.png.
// The real menu is drawn by the desktop and cannot be opened from a script,
// so the picture is a faithful mock: the panel strip with the tray icon and
// its dot, and above it the menu as Cinnamon draws it, with the agent icons
// of packages/tray/icons.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "packages", "tray", "icons");
const outDir = join(root, "media");

// Sessions as the demo data leaves them unread; titles from scripts/demo-data.mjs.
const sessions = [
  { agent: "claude", title: "Investigate flaky payment tests", machine: "This machine" },
  { agent: "codex", title: "Dark mode for the settings screen", machine: "This machine" },
  { agent: "claude", title: "Migrate orders table to UUID keys", machine: "hetzner" },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const iconData = (agent) => `data:image/png;base64,${readFileSync(join(iconsDir, `${agent}.png`)).toString("base64")}`;

// Geometry, in px at 1x; the PNG is rendered at 2x.
const W = 420;
const ROW = 34;
const PAD = 6;
const SEP = 9;
const menuH = PAD + sessions.length * ROW + SEP + ROW + PAD;
const PANEL = 40;
const GAP = 4;
const H = menuH + GAP + PANEL;
const menuX = W - 12 - 300 - 100;
const menuW = 300 + 100;

const rows = sessions
  .map((s, i) => {
    const y = PAD + i * ROW;
    return `
  <g transform="translate(${menuX},${y})">
    <image x="14" y="${(ROW - 20) / 2}" width="20" height="20" xlink:href="${iconData(s.agent)}"/>
    <text x="44" y="${ROW / 2 + 5}" class="label">${esc(s.title)} · ${esc(s.machine)}</text>
  </g>`;
  })
  .join("");

const sepY = PAD + sessions.length * ROW + SEP / 2;
const aboutY = PAD + sessions.length * ROW + SEP;

// The tray icon as packages/tray/icon.go draws it, with the dot.
const iconX = W - 12 - 22 - 60;
const iconY = menuH + GAP + (PANEL - 22) / 2;
const trayIcon = `
  <g transform="translate(${iconX},${iconY})">
    <rect x="2" y="4" width="18" height="12" fill="#e6e6e6"/>
    <rect x="4" y="6" width="14" height="8" fill="#2a2a2a"/>
    <rect x="6" y="8" width="5" height="1" fill="#e6e6e6"/>
    <rect x="6" y="11" width="8" height="1" fill="#e6e6e6"/>
    <rect x="10" y="16" width="2" height="3" fill="#e6e6e6"/>
    <rect x="6" y="19" width="10" height="2" fill="#e6e6e6"/>
    <circle cx="17" cy="5" r="5" fill="#0d1117"/>
    <circle cx="17" cy="5" r="4" fill="#3fb950"/>
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>
    .label { font: 13px "Noto Sans", "DejaVu Sans", Ubuntu, sans-serif; fill: #e8e8e8; }
    .clock { font: 13px "Noto Sans", "DejaVu Sans", Ubuntu, sans-serif; fill: #d0d0d0; }
  </style>
  <rect width="${W}" height="${H}" fill="#1e1e1e"/>
  <rect x="0" y="${menuH + GAP}" width="${W}" height="${PANEL}" fill="#2a2a2a"/>
  <text x="${W - 12}" y="${menuH + GAP + PANEL / 2 + 5}" text-anchor="end" class="clock">13:13</text>
  ${trayIcon}
  <rect x="${menuX}" y="0" width="${menuW}" height="${menuH}" rx="4" fill="#333333" stroke="#1a1a1a"/>
  ${rows}
  <line x1="${menuX + 8}" y1="${sepY}" x2="${menuX + menuW - 8}" y2="${sepY}" stroke="#222222"/>
  <text x="${menuX + 44}" y="${aboutY + ROW / 2 + 5}" class="label">About</text>
</svg>
`;

mkdirSync(outDir, { recursive: true });
const svgPath = join(outDir, "tray-menu.svg");
writeFileSync(svgPath, svg);
console.log(`wrote ${svgPath}`);

const pngPath = join(outDir, "tray-menu.png");
try {
  execFileSync("inkscape", ["--export-type=png", `--export-width=${W * 2}`, `--export-filename=${pngPath}`, svgPath], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`wrote ${pngPath}`);
} catch (err) {
  console.warn(`tray-screenshot: inkscape failed or is missing (${err.message}); only the SVG was written`);
}
