#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_BIN="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$REPO_DIR/logs"

# Find a Python venv with mlx_lm installed (for the LLM server)
MLX_VENV=""
for candidate in "$REPO_DIR/.mlx-venv" "$HOME/.mlx-venv" "$REPO_DIR/embed-service/.venv"; do
  if [ -f "$candidate/bin/python" ] && "$candidate/bin/python" -c "import mlx_lm" 2>/dev/null; then
    MLX_VENV="$candidate"
    break
  fi
done

if [ -z "$MLX_VENV" ]; then
  echo "⚠ No Python venv with mlx_lm found."
  echo "  Create one: python3 -m venv ~/.mlx-venv && ~/.mlx-venv/bin/pip install mlx-lm"
  echo "  Skipping LLM service plist. Other services will still be installed."
fi

mkdir -p "$LOG_DIR" "$LAUNCH_DIR"

# openbrain owns local inference: it runs its own mlx_lm server on :8000.
# A legacy system-wide daemon (com.lcars.mlx-server) historically also bound
# :8000; if it is still loaded, the two KeepAlive services fight over the port
# and one crash-loops. Detect it and tell the operator to retire it.
if launchctl print "system/com.lcars.mlx-server" >/dev/null 2>&1 \
   || [ -f /Library/LaunchDaemons/com.lcars.mlx-server.plist ]; then
  echo "⚠ Conflicting MLX server detected: com.lcars.mlx-server owns :8000."
  echo "  openbrain now owns local inference. Retire the legacy daemon:"
  echo "    sudo launchctl bootout system/com.lcars.mlx-server"
  echo "    sudo rm /Library/LaunchDaemons/com.lcars.mlx-server.plist"
  echo ""
fi

echo "=== Installing OpenBrain launchd services ==="
echo "  Repo: $REPO_DIR"
echo "  Bun:  $BUN_BIN"
echo ""

# Helper: generate plist from template
install_plist() {
  local name="$1"
  local src="$REPO_DIR/launchd/$name.plist"
  local dst="$LAUNCH_DIR/$name.plist"

  if [ ! -f "$src" ]; then
    echo "  ✗ Template not found: $src"
    return 1
  fi

  # If $dst is a stale symlink (e.g. pointing at the repo template), `>` would
  # follow it and overwrite the template. Remove first so we always write a real
  # file with placeholders substituted.
  rm -f "$dst"
  GOG_PW="${GOG_KEYRING_PASSWORD:-}"
  if [ -z "$GOG_PW" ] && [ -f "$REPO_DIR/.env" ]; then
    GOG_PW="$(grep '^GOG_KEYRING_PASSWORD=' "$REPO_DIR/.env" | cut -d= -f2-)"
  fi

  # Model served by com.openbrain.llm comes from .env (LLM_MODEL), so a re-run
  # of this installer preserves the machine's chosen model instead of resetting
  # it to a hardcoded default. Falls back to the 16GB-safe default.
  LLM_MODEL_VAL="${LLM_MODEL:-}"
  if [ -z "$LLM_MODEL_VAL" ] && [ -f "$REPO_DIR/.env" ]; then
    LLM_MODEL_VAL="$(grep '^LLM_MODEL=' "$REPO_DIR/.env" | cut -d= -f2-)"
  fi
  LLM_MODEL_VAL="${LLM_MODEL_VAL:-mlx-community/Qwen3-8B-4bit}"

  sed \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__REPO__|$REPO_DIR|g" \
    -e "s|__BUN__|$BUN_BIN|g" \
    -e "s|__VENV__|${MLX_VENV:-__VENV__}|g" \
    -e "s|__LLM_MODEL__|$LLM_MODEL_VAL|g" \
    -e "s|__GOG_KEYRING_PASSWORD__|$GOG_PW|g" \
    "$src" > "$dst"

  # Unload if already loaded, then load
  launchctl unload "$dst" 2>/dev/null || true
  launchctl load "$dst"
  echo "  ✓ $name"
}

install_plist "com.openbrain.mcp"
install_plist "com.openbrain.embed"
install_plist "com.openbrain.ui"
install_plist "com.openbrain.poll"

if [ -n "$MLX_VENV" ]; then
  install_plist "com.openbrain.llm"
else
  echo "  ⊘ com.openbrain.llm (skipped — no mlx_lm venv)"
fi

echo ""
echo "=== Done ==="
echo "Services are now running. Check with: bun run scripts/health-check.ts"
echo "Logs in: $LOG_DIR/"
echo "To uninstall: bash scripts/uninstall-services.sh"
