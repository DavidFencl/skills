#!/usr/bin/env bash
# Installs capture.mjs dependencies into a per-user cache, never into the project under review.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_HOME="${UI_CHANGELOG_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/ui-changelog}"

mkdir -p "$TOOL_HOME"
if ! cmp -s "$SCRIPT_DIR/package.json" "$TOOL_HOME/package.json" || [ ! -d "$TOOL_HOME/node_modules/playwright" ]; then
  cp "$SCRIPT_DIR/package.json" "$TOOL_HOME/package.json"
  npm install --prefix "$TOOL_HOME" --no-audit --no-fund --loglevel=error
fi
"$TOOL_HOME/node_modules/.bin/playwright" install chromium
echo "ui-changelog tools ready in $TOOL_HOME"
