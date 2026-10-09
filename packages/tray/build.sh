#!/bin/sh
# Builds the tray helper for every supported Linux architecture into the
# extension's dist folder, where esbuild output lives too.
set -eu
cd "$(dirname "$0")"
out="../extension/dist/tray"
for arch in amd64 arm64; do
  mkdir -p "$out/linux-$arch"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -buildvcs=false -trimpath -ldflags="-s -w" -o "$out/linux-$arch/agent-sessions-tray" .
done
