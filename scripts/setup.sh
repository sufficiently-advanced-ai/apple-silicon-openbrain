#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== OpenBrain Setup ==="

# PostgreSQL
echo "→ Checking PostgreSQL..."
PG_PREFIX="$(brew --prefix postgresql@17 2>/dev/null || true)"
if [ -n "$PG_PREFIX" ] && [ -d "$PG_PREFIX/bin" ]; then
  export PATH="$PG_PREFIX/bin:$PATH"
fi

if ! command -v psql &>/dev/null; then
  echo "  ✗ psql not found. Install PostgreSQL 17: brew install postgresql@17"
  exit 1
fi

if ! brew services list | grep -q "postgresql@17.*started"; then
  echo "  Starting PostgreSQL 17..."
  brew services start postgresql@17
  sleep 2
fi

if ! psql -lqt | cut -d \| -f 1 | grep -qw openbrain; then
  echo "  Creating openbrain database..."
  createdb openbrain
fi

psql openbrain -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null
echo "  ✓ PostgreSQL ready"

# Node dependencies via pnpm (needed before migrations — migrate.ts uses postgres.js)
echo "→ Installing dependencies (pnpm)..."
cd "$REPO_DIR"
if ! command -v pnpm &>/dev/null; then
  echo "  ✗ pnpm not found. Install with: brew install pnpm"
  echo "    (also requires Node 22+; nvm install --lts && nvm alias default lts/*)"
  exit 1
fi
pnpm install --silent
echo "  ✓ Dependencies installed"

# Schema: apply ALL migrations (drizzle/*.sql) via the tracked runner. The old
# inline schema here only covered migration 0000 and shipped broken installs
# (no governance columns, no memory_links/memory_audit/sources tables).
echo "→ Applying migrations..."
bun run src/db/migrate.ts
echo "  ✓ Schema up to date"

# Python embedding service
echo "→ Setting up embedding service..."
cd "$REPO_DIR/embed-service"
uv sync --quiet
echo "  ✓ Embedding service ready"

echo ""
echo "=== Setup Complete ==="
echo "Start services:"
echo "  bun run dev                          # MCP server (port 6277)"
echo "  cd embed-service && uv run server.py # Embedding service (port 6278)"
