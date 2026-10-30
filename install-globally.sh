#!/usr/bin/env bash
#
# install-globally.sh: symlink every skill in skills/ into the skill folder of each agent
# harness installed on this machine, so updates to this repo apply everywhere.
#
#   Claude Code  ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/
#   Codex        ${CODEX_HOME:-~/.codex}/skills/
#   pi           ${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/
#   Grok         ${GROK_HOME:-~/.grok}/skills/
#
# A harness is skipped when its config directory does not exist. Safe to re-run. A destination
# that already exists as a real directory (not a symlink) is left untouched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

declare -A HARNESSES=(
  ["Claude Code"]="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  ["Codex"]="${CODEX_HOME:-$HOME/.codex}"
  ["pi"]="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  ["Grok"]="${GROK_HOME:-$HOME/.grok}"
)

install_link() {
  local target="$1"
  local link="$2"

  if [ -d "$link" ] && [ ! -L "$link" ]; then
    echo "  ⚠  skipping ${link}: it is a real directory, not a symlink"
    return 0
  fi

  ln -sfn "$target" "$link"
  echo "  ✓  ${link} → ${target}"
}

for harness in "${!HARNESSES[@]}"; do
  root="${HARNESSES[$harness]}"
  skills_dir="$root/skills"
  if [ ! -d "$root" ]; then
    echo "${harness}: not installed (${root} missing), skipped"
    continue
  fi
  echo "${harness} → ${skills_dir}"
  mkdir -p "$skills_dir"
  for skill_dir in "$SCRIPT_DIR"/skills/*/; do
    [ -e "${skill_dir}SKILL.md" ] || continue
    install_link "${skill_dir%/}" "${skills_dir}/$(basename "$skill_dir")"
  done
done

echo ""
echo "Done. Restart running agent sessions to pick up new skills."
