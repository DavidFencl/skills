#!/usr/bin/env bash
# Installs capture.mjs dependencies into a per-user cache, never into the project under review,
# then checks that the browser starts. Idempotent: run it before the first capture of a session.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_HOME="${UI_CHANGELOG_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/ui-changelog}"

mkdir -p "$TOOL_HOME"
if ! cmp -s "$SCRIPT_DIR/package.json" "$TOOL_HOME/package.json" || [ ! -d "$TOOL_HOME/node_modules/playwright" ]; then
  cp "$SCRIPT_DIR/package.json" "$TOOL_HOME/package.json"
  npm install --prefix "$TOOL_HOME" --no-audit --no-fund --loglevel=error
fi
"$TOOL_HOME/node_modules/.bin/playwright" install chromium

# A sandbox or a machine without Chromium's system libraries fails here, not halfway through a capture.
if ! (cd "$TOOL_HOME" && node --input-type=module -e "
  import { createRequire } from 'node:module';
  const { chromium } = createRequire(process.cwd() + '/package.json')('playwright');
  const browser = await chromium.launch();
  await browser.close();
"); then
  echo "Chromium does not start here. Missing system libraries are installed with: $TOOL_HOME/node_modules/.bin/playwright install-deps chromium (needs root)." >&2
  exit 1
fi
echo "ui-changelog tools ready in $TOOL_HOME"
