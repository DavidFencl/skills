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
# A harness is skipped when its config directory does not exist. Safe to re-run. The installer
# changes only its own links, the symlinks that resolve to this repo's skills, and dangling
# symlinks. Anything else at a destination, such as a real directory or a link to another copy,
# is left untouched. Runs on bash 3.2 (macOS) and later.
#
# The Luxonis version of a skill always wins. A skill that the luxonis CLI installed on this
# machine, or could not install because this repo's link held the name, is never linked from
# this repo, and the installer removes its own earlier link so the CLI installs the pack's copy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# One skill name per line: the skills the luxonis CLI installed on this machine, and the pack
# skills it skipped because another copy held the name. `skills status` reads only local state,
# so it answers signed out and offline. Prints nothing when the CLI or node is missing.
luxonis_skills() {
  command -v luxonis >/dev/null 2>&1 || return 0
  if ! command -v node >/dev/null 2>&1; then
    echo "⚠  node not found, so the skills the luxonis CLI installs are not checked" >&2
    return 0
  fi
  luxonis skills status --json 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      try {
        const { installed = [], conflicts = [] } = JSON.parse(text);
        const names = new Set(installed.map((skill) => skill.name));
        for (const conflict of conflicts) if (conflict.reason === "external-owner") names.add(conflict.name);
        if (names.size) console.log([...names].join("\n"));
      } catch {
        console.error("⚠  luxonis skills status failed, so the skills the luxonis CLI installs are not checked");
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

# The physical directory a path resolves to, or nothing when it does not resolve to one.
resolve() {
  (cd "$1" 2>/dev/null && pwd -P) || true
}

# absent, dangling, own (a symlink that resolves to this repo's copy), or foreign.
link_state() {
  local target="$1"
  local link="$2"

  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    echo absent
  elif [ -L "$link" ] && [ ! -e "$link" ]; then
    echo dangling
  elif [ -L "$link" ] && [ "$(resolve "$link")" = "$(resolve "$target")" ]; then
    echo own
  else
    echo foreign
  fi
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
    target="${skill_dir%/}"
    link="${skills_dir}/${name}"
    state="$(link_state "$target" "$link")"
    if provided_by_luxonis "$name"; then
      case "$state" in
        own | dangling)
          rm "$link"
          echo "  ✗  ${link}: removed, run luxonis tick to install the Luxonis copy"
          ;;
        *) echo "  ↷  skipping ${name}: the luxonis CLI installs it" ;;
      esac
    else
      case "$state" in
        foreign) echo "  ⚠  skipping ${link}: it holds a copy this repo did not install" ;;
        *)
          ln -sfn "$target" "$link"
          echo "  ✓  ${link} → ${target}"
          ;;
      esac
    fi
  done
done

echo ""
echo "Done. Restart running agent sessions to pick up new skills."
