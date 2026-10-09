#!/bin/sh
# Renders the agent icons of the tree (packages/extension/resources/*.svg,
# made by scripts/gen-icons.mjs) to PNG for the tray menu, which takes
# icon-data as PNG bytes. Needs inkscape; the result is committed.
set -eu
cd "$(dirname "$0")"
for a in claude codex opencode; do
  inkscape --export-type=png --export-width=32 --export-height=32 --export-filename="icons/$a.png" "../extension/resources/$a.svg"
done
