#!/usr/bin/env bash
#
# install-globally.sh: symlink every skill in skills/ into the folders the agent harnesses on
# this machine load skills from, so updates to this repo apply everywhere. They are the folders
# the luxonis CLI installs into.
#
#   Orca, Codex, pi  ~/.agents/skills/
#   Claude Code      ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/
#   Grok             ${GROK_HOME:-~/.grok}/skills/
#
# Codex and pi read ~/.agents/skills, so a link in ~/.codex/skills or ~/.pi/agent/skills would
# show them a second copy. The installer removes its own earlier links there.
#
# A folder is skipped when its harness is not installed. Safe to re-run. The installer changes
# only its own links, the symlinks that resolve to this repo's skills, and dangling symlinks.
# Anything else, such as a real directory or a link to another copy, is left untouched. Runs on
# bash 3.2 (macOS) and later.
#
# The Luxonis version of a skill always wins. The installer removes its own links to a skill the
# luxonis CLI installed. When the CLI reports that another copy kept a pack skill out, the
# installer removes its own links, runs `luxonis tick`, and links its copy again only if the CLI
# still did not install the pack's copy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TARGETS="agents claude grok"
RETIRED="codex pi"

# Plain functions instead of associative arrays, so the script runs on macOS's bash 3.2.
harness_name() {
  case "$1" in
    agents) echo "Orca, Codex and pi" ;;
    claude) echo "Claude Code" ;;
    grok) echo "Grok" ;;
    codex) echo "Codex" ;;
    pi) echo "pi" ;;
  esac
}
# Each harness's own override variable wins over its default directory.
harness_root() {
  case "$1" in
    agents) echo "${HOME}/.agents" ;;
    claude) echo "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}" ;;
    grok) echo "${GROK_HOME:-${HOME}/.grok}" ;;
    codex) echo "${CODEX_HOME:-${HOME}/.codex}" ;;
    pi) echo "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}" ;;
  esac
}

# "installed <name>" for each skill the luxonis CLI installed on this machine, and
# "blocked <name>" for each pack skill it skipped because another copy held the name.
# `skills status` reads only local state. Prints "unknown" when the status cannot be read, and
# nothing when the CLI is not installed.
luxonis_status() {
  command -v luxonis >/dev/null 2>&1 || return 0
  if ! command -v node >/dev/null 2>&1; then
    echo "⚠  node not found, so the skills the luxonis CLI installs are not checked" >&2
    echo unknown
    return 0
  fi
  luxonis skills status --json 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      let status;
      try {
        status = JSON.parse(text);
      } catch {
        console.error("⚠  luxonis skills status failed, so the skills the luxonis CLI installs are not checked");
        console.log("unknown");
        return;
      }
      for (const skill of status.installed ?? []) console.log(`installed ${skill.name}`);
      for (const conflict of [...(status.conflicts ?? []), ...(status.lastRun?.conflicts ?? [])])
        if (conflict.reason === "external-owner") console.log(`blocked ${conflict.name}`);
    });
  ' || echo unknown
}

STATUS="$(luxonis_status)"

status_has() {
  case "
${STATUS}
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

# The skill's name from its SKILL.md frontmatter, which is how the CLI and the harnesses know it.
# Quotes, a trailing comment and trailing spaces are dropped, as a YAML parser drops them.
skill_name() {
  local name
  name="$(awk '
    { sub(/\r$/, "") }
    NR == 1 { if ($0 != "---") exit; next }
    /^---[ \t]*$/ { exit }
    /^name:/ { sub(/^name:[ \t]*/, ""); sub(/[ \t]+#.*$/, ""); sub(/[ \t]+$/, ""); gsub(/["\047]/, ""); print; exit }
  ' "$1/SKILL.md")"
  echo "${name:-$(basename "$1")}"
}

REPO_SKILLS="$(resolve "${SCRIPT_DIR}/skills")"

# The skills folder of a harness, when the installer may change it. ~/.agents/skills is created
# when Codex or pi is installed, since both read it.
usable_dir() {
  local root
  local dir
  root="$(harness_root "$1")"
  dir="${root}/skills"
  if [ ! -d "$root" ]; then
    [ "$1" = agents ] || return 1
    [ -d "$(harness_root codex)" ] || [ -d "$(harness_root pi)" ] || return 1
  fi
  [ -L "$dir" ] && [ ! -e "$dir" ] && return 1
  [ -n "$REPO_SKILLS" ] && [ "$(resolve "$dir")" = "$REPO_SKILLS" ] && return 1
  echo "$dir"
}

DIRS=""
AGENTS_DIR=""
for harness in $TARGETS; do
  if dir="$(usable_dir "$harness")"; then
    mkdir -p "$dir"
    DIRS="${DIRS}${dir}
"
    [ "$harness" = agents ] && AGENTS_DIR="$dir"
    echo "$(harness_name "$harness") → ${dir}"
  else
    echo "$(harness_name "$harness"): skipped, $(harness_root "$harness")/skills is missing, dangling or this repo's skills folder"
  fi
done

# True when a folder is, or resolves to, a folder the installer links into or this repo's skills.
is_linked_dir() {
  local resolved
  local dir
  resolved="$(resolve "$1")"
  [ -n "$resolved" ] || return 1
  [ "$resolved" = "$REPO_SKILLS" ] && return 0
  while IFS= read -r dir; do
    [ -n "$dir" ] && [ "$(resolve "$dir")" = "$resolved" ] && return 0
  done <<< "$DIRS"
  return 1
}

link_free() {
  local target="$1"
  local dir
  local link

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    link="${dir}/$(basename "$target")"
    case "$(link_state "$target" "$link")" in
      foreign) echo "  ⚠  skipping ${link}: it holds a copy this repo did not install" ;;
      *)
        ln -sfn "$target" "$link"
        echo "  ✓  ${link} → ${target}"
        ;;
    esac
  done <<< "$DIRS"
}

remove_own() {
  local target="$1"
  local reason="$2"
  local dir
  local link

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    link="${dir}/$(basename "$target")"
    case "$(link_state "$target" "$link")" in
      own | dangling)
        rm "$link"
        echo "  ✗  ${link}: removed, ${reason}"
        ;;
    esac
  done <<< "$DIRS"
}

BLOCKED=""
for skill_dir in "$SCRIPT_DIR"/skills/*/; do
  [ -e "${skill_dir}SKILL.md" ] || continue
  target="${skill_dir%/}"
  name="$(skill_name "$target")"
  if status_has "installed ${name}"; then
    remove_own "$target" "the Luxonis copy of ${name} is installed"
    echo "  ↷  ${name}: the luxonis CLI installed its copy"
  elif status_has "blocked ${name}"; then
    remove_own "$target" "so the luxonis CLI can install ${name}"
    BLOCKED="${BLOCKED}${target}
"
  else
    link_free "$target"
  fi

  # Old Codex and pi links go only once ~/.agents/skills has this repo's skills for them.
  [ -n "$AGENTS_DIR" ] || continue
  for harness in $RETIRED; do
    root="$(harness_root "$harness")"
    link="${root}/skills/$(basename "$target")"
    [ -d "${root}/skills" ] || continue
    is_linked_dir "${root}/skills" && continue
    if [ "$(link_state "$target" "$link")" = own ]; then
      rm "$link"
      echo "  ✗  ${link}: removed, $(harness_name "$harness") reads ~/.agents/skills"
    fi
  done
done

if [ -n "$BLOCKED" ]; then
  echo ""
  echo "Running luxonis tick to install the Luxonis copies"
  luxonis tick >/dev/null 2>&1 || echo "⚠  luxonis tick reported a problem, see luxonis skills status"
  STATUS="$(luxonis_status)"
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    name="$(skill_name "$target")"
    if status_has "installed ${name}"; then
      echo "  ✓  ${name}: the Luxonis copy is installed"
    else
      echo "  ⚠  ${name}: the Luxonis copy is still not installed, so this repo's copy is linked again"
      link_free "$target"
    fi
  done <<< "$BLOCKED"
fi

echo ""
echo "Done. Restart running agent sessions to pick up new skills."
