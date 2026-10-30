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
# that already exists as a real directory (not a symlink) is left untouched. Runs on bash 3.2
# (macOS) and later.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Plain functions instead of associative arrays, so the script runs on macOS's bash 3.2.
harness_name() {
  case "$1" in
    claude) echo "Claude Code" ;;
    codex) echo "Codex" ;;
    pi) echo "pi" ;;
    grok) echo "Grok" ;;
  esac
}
# Each harness's own override variable wins over its default directory.
harness_root() {
  case "$1" in
    claude) echo "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}" ;;
    codex) echo "${CODEX_HOME:-${HOME}/.codex}" ;;
    pi) echo "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}" ;;
    grok) echo "${GROK_HOME:-${HOME}/.grok}" ;;
  esac
}

for harness in claude codex pi grok; do
  root="$(harness_root "$harness")"
  skills_dir="${root}/skills"
  if [ ! -d "$root" ]; then
    echo "$(harness_name "$harness"): not installed (${root} missing), skipped"
    continue
  fi
  echo "$(harness_name "$harness") → ${skills_dir}"
  mkdir -p "$skills_dir"
  for skill_dir in "$SCRIPT_DIR"/skills/*/; do
    [ -e "${skill_dir}SKILL.md" ] || continue
    install_link "${skill_dir%/}" "${skills_dir}/$(basename "$skill_dir")"
  done
done

echo ""
echo "Done. Restart running agent sessions to pick up new skills."
