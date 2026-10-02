import { mkdirSync, writeFileSync } from "node:fs";

const agents = {
  claude: ["#4A2A1C", "A", "#FF8A2A"],
  codex: ["#3A3A3A", "C", "#FFFFFF"],
  opencode: ["#7C3AED", "O", "#FFFFFF"],
};
mkdirSync("resources", { recursive: true });

// A pushpin in the bottom left corner, clear of the unread dot at the top right.
const PIN = `<path d="M.9 8.9h5.2v1.3h-.9l.9 2.6H.9l.9-2.6h-.9z" fill="#58A6FF" stroke="#0d1117" stroke-width="0.8" stroke-linejoin="round"/><path d="M3.5 12.8v2.7" stroke="#0d1117" stroke-width="2" stroke-linecap="round"/><path d="M3.5 12.8v2.7" stroke="#58A6FF" stroke-width="0.9" stroke-linecap="round"/>`;

function icon(color, letter, fg, variant, pinned = false) {
  const opacity = variant === "hidden" ? "0.4" : "1";
  const dot = variant === "unread" ? `<circle cx="13" cy="3" r="3" fill="#3FB950" stroke="#0d1117" stroke-width="0.8"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<g opacity="${opacity}"><rect x="1" y="1" width="14" height="14" rx="3" fill="${color}"/>
<text x="8" y="11.5" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" font-weight="bold" fill="${fg}">${letter}</text></g>${dot}${pinned ? PIN : ""}
</svg>
`;
}

for (const [agent, [color, letter, fg]] of Object.entries(agents)) {
  for (const variant of ["plain", "unread", "hidden"]) {
    const name = variant === "plain" ? agent : `${agent}-${variant}`;
    writeFileSync(`resources/${name}.svg`, icon(color, letter, fg, variant));
    writeFileSync(`resources/${name}-pinned.svg`, icon(color, letter, fg, variant, true));
  }
}

writeFileSync(
  "resources/view-icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 9h4M7 12h7"/></svg>
`,
);
