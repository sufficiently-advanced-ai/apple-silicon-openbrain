#!/usr/bin/env bash
set -euo pipefail

LAUNCH_DIR="$HOME/Library/LaunchAgents"

echo "=== Uninstalling OpenBrain launchd services ==="

for name in com.openbrain.mcp com.openbrain.embed com.openbrain.llm com.openbrain.ui com.openbrain.poll; do
  plist="$LAUNCH_DIR/$name.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm "$plist"
    echo "  ✓ Removed $name"
  else
    echo "  ⊘ $name (not installed)"
  fi
done

echo ""
echo "=== Done ==="
