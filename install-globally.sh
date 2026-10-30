#!/usr/bin/env bash
#
# install-globally.sh — symlink the skills and extensions into each installed harness's global
# config so they're available in every project.
#
#   skills/*/       (harness-neutral)  →  ~/.claude/skills, ~/.codex/skills, ~/.grok/skills, ~/.pi/agent/skills
#   pi/skills/*/    (pi only)          →  ~/.pi/agent/skills
#   pi/extensions/*.ts                 →  ~/.pi/agent/extensions
#
# A harness counts as installed when its config directory exists (~/.claude, ~/.codex, ~/.grok, ~/.pi).
# Safe to re-run: it recreates the symlinks idempotently. If a destination already exists as a real
# directory (not a symlink), it is left untouched.
#
# Usage:
#   ./install-globally.sh
#
# Then restart the harness (or run /reload in pi).

set -euo pipefail

# Resolve the repository root (the directory containing this script), so the
# script works regardless of the current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Link every skill directory under $1 into $2.
install_skills() {
  local source_dir="$1"
  local dest_dir="$2"
  mkdir -p "$dest_dir"
  for skill_dir in "$source_dir"/*/; do
    [ -e "${skill_dir}SKILL.md" ] || continue
    install_link "$skill_dir" "${dest_dir}/$(basename "$skill_dir")"
  done
}

declare -A HARNESS_HOME=(
  [claude]="${HOME}/.claude"
  [codex]="${HOME}/.codex"
  [grok]="${HOME}/.grok"
  [pi]="${HOME}/.pi"
)
declare -A HARNESS_SKILLS=(
  [claude]="${HOME}/.claude/skills"
  [codex]="${HOME}/.codex/skills"
  [grok]="${HOME}/.grok/skills"
  [pi]="${HOME}/.pi/agent/skills"
)

for harness in claude codex grok pi; do
  if [ ! -d "${HARNESS_HOME[$harness]}" ]; then
    echo "Skipping ${harness} — ${HARNESS_HOME[$harness]} not found"
    continue
  fi
  echo "Installing harness-neutral skills for ${harness} → ${HARNESS_SKILLS[$harness]}"
  install_skills "$SCRIPT_DIR/skills" "${HARNESS_SKILLS[$harness]}"
done

if [ -d "${HARNESS_HOME[pi]}" ]; then
  echo "Installing pi-only skills → ${HARNESS_SKILLS[pi]}"
  install_skills "$SCRIPT_DIR/pi/skills" "${HARNESS_SKILLS[pi]}"

  GLOBAL_EXTENSIONS_DIR="${HOME}/.pi/agent/extensions"
  mkdir -p "$GLOBAL_EXTENSIONS_DIR"
  echo "Installing pi extensions → ${GLOBAL_EXTENSIONS_DIR}"
  for ext in "$SCRIPT_DIR"/pi/extensions/*.ts; do
    [ -e "$ext" ] || continue
    install_link "$ext" "${GLOBAL_EXTENSIONS_DIR}/$(basename "$ext")"
  done
fi

echo ""
echo "Done. Restart your harness (or run /reload in pi) to pick up the changes."
