#!/bin/bash
set -e
cd "$(dirname "$0")/daemon"

go mod tidy
wails build -clean -ldflags "-s -w"

echo "Build complete! App is in daemon/build/bin/"
