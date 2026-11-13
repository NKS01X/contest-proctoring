#!/bin/bash
echo "Compiling for Windows (amd64)..."
GOOS=windows GOARCH=amd64 go build -o bin/monitor-win.exe ./daemon

echo "Compiling for Linux (amd64)..."
GOOS=linux GOARCH=amd64 go build -o bin/monitor-linux ./daemon

echo "Build complete! Binaries are in the bin/ directory."
