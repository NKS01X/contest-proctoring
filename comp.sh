#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/bin"
cd "$ROOT/daemon"

echo "Compiling for Windows (amd64)..."
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o "$ROOT/bin/monitor-win.exe" .

echo "Compiling for Linux (amd64)..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$ROOT/bin/monitor-linux" .

echo "Build complete! Binaries are in the bin/ directory."
