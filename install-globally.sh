#!/usr/bin/env bash
#
# install-globally.sh: symlink every skill in skills/ into the skill folder of each agent
# harness installed on this machine, so updates to this repo apply everywhere.
#
#   Claude Code  ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/
#   Codex        ${CODEX_HOME:-~/.codex}/skills/
#   pi           ${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/
#   Grok         ${GROK_HOME:-~/.grok}/skills/
#   Orca/shared  ~/.agents/skills/
#
# A harness is skipped when its config directory does not exist. Safe to re-run. A destination
# that already exists as a real directory (not a symlink) is left untouched. Runs on bash 3.2
# (macOS) and later.
#
# The Luxonis version of a skill always wins. A skill that an enabled Luxonis Knowledge pack
# provides is never linked from this repo, and an earlier link to this repo's copy is removed,
# so the luxonis CLI installs the pack's copy on its next sync.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# One skill name per line, from the packs that are on for this person and the skills added on
# this machine. Prints nothing when the luxonis CLI is missing, signed out or offline.
luxonis_skills() {
  command -v luxonis >/dev/null 2>&1 || return 0
  if ! command -v node >/dev/null 2>&1; then
    echo "⚠  node not found, so Luxonis pack skills are not checked" >&2
    return 0
  fi
  luxonis skills list --json 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      try {
        const { packs = [], installed = [] } = JSON.parse(text);
        const names = new Set(installed.map((skill) => skill.name));
        for (const pack of packs) if (pack.enabled) for (const name of pack.skills) names.add(name);
        if (names.size) console.log([...names].join("\n"));
      } catch {
        console.error("⚠  luxonis skills list failed, so Luxonis pack skills are not checked");
      }
    });
  ' || true
}

LUXONIS_SKILLS="$(luxonis_skills)"

provided_by_luxonis() {
  case "
${LUXONIS_SKILLS}
" in
    *"
$1
"*) return 0 ;;
  esac
  return 1
}

yield_to_luxonis() {
  local target="$1"
  local link="$2"
  local current

  if [ -L "$link" ]; then
    current="$(readlink "$link")"
    if [ "$current" = "$target" ] || [ "$current" = "${target}/" ]; then
      rm "$link"
      echo "  ✗  ${link}: removed, the Luxonis pack's copy replaces it after luxonis tick"
      return 0
    fi
  fi
  echo "  ↷  skipping $(basename "$link"): a Luxonis pack provides it"
}

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
    agents) echo "Orca / Agent Skills" ;;
    claude) echo "Claude Code" ;;
    codex) echo "Codex" ;;
    pi) echo "pi" ;;
    grok) echo "Grok" ;;
  esac
}
# Each harness's own override variable wins over its default directory.
harness_root() {
  case "$1" in
    agents) echo "${HOME}/.agents" ;;
    claude) echo "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}" ;;
    codex) echo "${CODEX_HOME:-${HOME}/.codex}" ;;
    pi) echo "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}" ;;
    grok) echo "${GROK_HOME:-${HOME}/.grok}" ;;
  esac
}

for harness in agents claude codex pi grok; do
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
    name="$(basename "$skill_dir")"
    if provided_by_luxonis "$name"; then
      yield_to_luxonis "${skill_dir%/}" "${skills_dir}/${name}"
    else
      install_link "${skill_dir%/}" "${skills_dir}/${name}"
    fi
  done
done

echo ""
echo "Done. Restart running agent sessions to pick up new skills."
