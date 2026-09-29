import { mkdirSync, writeFileSync } from "node:fs";

const agents = {
  claude: ["#4A2A1C", "A", "#FF8A2A"],
  codex: ["#3A3A3A", "C", "#FFFFFF"],
  opencode: ["#7C3AED", "O", "#FFFFFF"],
};
mkdirSync("resources", { recursive: true });

function icon(color, letter, fg, variant) {
  const opacity = variant === "hidden" ? "0.4" : "1";
  const dot = variant === "running" ? `<circle cx="13" cy="3" r="3" fill="#3FB950" stroke="#0d1117" stroke-width="0.8"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<g opacity="${opacity}"><rect x="1" y="1" width="14" height="14" rx="3" fill="${color}"/>
<text x="8" y="11.5" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" font-weight="bold" fill="${fg}">${letter}</text></g>${dot}
</svg>
`;
}

for (const [agent, [color, letter, fg]] of Object.entries(agents)) {
  writeFileSync(`resources/${agent}.svg`, icon(color, letter, fg, "plain"));
  writeFileSync(`resources/${agent}-running.svg`, icon(color, letter, fg, "running"));
  writeFileSync(`resources/${agent}-hidden.svg`, icon(color, letter, fg, "hidden"));
}

writeFileSync(
  "resources/view-icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 9h4M7 12h7"/></svg>
`,
);
