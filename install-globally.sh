#!/usr/bin/env bash
#
# install-globally.sh — symlink all skills and extensions into pi's global
# config directories so they're available in every project.
#
#   ~/.pi/agent/skills/       ←  pi/skills/*/        (directories with SKILL.md)
#   ~/.pi/agent/extensions/   ←  pi/extensions/*.ts
#
# Safe to re-run: it recreates the symlinks idempotently. If a destination
# already exists as a real directory (not a symlink), it is left untouched.
#
# Usage:
#   ./install-globally.sh
#
# Then restart pi, or run /reload in a running session.

set -euo pipefail

# Resolve the repository root (the directory containing this script), so the
# script works regardless of the current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GLOBAL_SKILLS_DIR="${HOME}/.pi/agent/skills"
GLOBAL_EXTENSIONS_DIR="${HOME}/.pi/agent/extensions"

mkdir -p "$GLOBAL_SKILLS_DIR" "$GLOBAL_EXTENSIONS_DIR"

# Symlink a target to a destination, but never clobber a real directory.
install_link() {
  local target="$1"
  local link="$2"

  if [ -d "$link" ] && [ ! -L "$link" ]; then
    echo "  ⚠  skipping ${link} — it is a real directory, not a symlink"
    return 0
  fi

  ln -sfn "$target" "$link"
  echo "  ✓  $(basename "$link") → ${target}"
}

echo "Installing skills → ${GLOBAL_SKILLS_DIR}"
for skill_dir in "$SCRIPT_DIR"/pi/skills/*/; do
  [ -e "${skill_dir}SKILL.md" ] || continue
  install_link "$skill_dir" "${GLOBAL_SKILLS_DIR}/$(basename "$skill_dir")"
done

echo "Installing extensions → ${GLOBAL_EXTENSIONS_DIR}"
for ext in "$SCRIPT_DIR"/pi/extensions/*.ts; do
  [ -e "$ext" ] || continue
  install_link "$ext" "${GLOBAL_EXTENSIONS_DIR}/$(basename "$ext")"
done

echo ""
echo "Done. Restart pi (or run /reload) to pick up the changes."
