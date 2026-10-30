#!/usr/bin/env bash
#
# install-globally.sh: symlink every skill in skills/ into the skill folder of each agent
# harness installed on this machine, so updates to this repo apply everywhere.
#
#   Claude Code  ~/.claude/skills/
#   Codex        ~/.codex/skills/
#   pi           ~/.pi/agent/skills/
#   Grok         ~/.grok/skills/
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
harness_root() {
  if [ "$1" = pi ]; then echo "${HOME}/.pi/agent"; else echo "${HOME}/.$1"; fi
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
