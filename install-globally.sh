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
# The Luxonis version of a skill always wins. When the luxonis CLI installed a skill on this
# machine, or its last good sync skipped a pack skill because this repo's links held the name,
# the installer removes its own links so the CLI's copy takes the name.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HARNESSES="agents claude codex pi grok"

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
skills_dir_of() {
  echo "$(harness_root "$1")/skills"
}

# "installed <name>" for each skill the luxonis CLI installed on this machine, and
# "blocked <name>" for each pack skill its last good sync skipped because another copy held the
# name. `skills status` reads only local state. Prints "unknown" when the status cannot be read,
# and nothing when the CLI is not installed.
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
      // A signed-out or failed sync keeps the conflicts of an older run, which may be stale.
      if (status.lastRun?.feed !== "enabled") return;
      for (const conflict of [...(status.conflicts ?? []), ...(status.lastRun.conflicts ?? [])])
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

# The first harness path that holds a copy of the skill this repo did not install.
foreign_copy() {
  local name="$1"
  local target="$2"
  local harness
  local link

  for harness in $HARNESSES; do
    link="$(skills_dir_of "$harness")/${name}"
    if [ "$(link_state "$target" "$link")" = foreign ]; then
      echo "$link"
      return 0
    fi
  done
  return 1
}

# installed: the CLI's copy is here, so this repo's links go.
# blocked: this repo's links are all that keep the CLI from installing its copy, so they go.
# held: the status is unknown and ~/.agents/skills already has another copy, so nothing is linked.
# link: this repo's copy is linked wherever the name is free.
plan_for() {
  local name="$1"
  local target="$2"
  local holder

  if status_has "installed ${name}"; then
    echo installed
  elif status_has "blocked ${name}"; then
    if holder="$(foreign_copy "$name" "$target")"; then
      echo "⚠  ${name}: ${holder} keeps the Luxonis copy out, so this repo's links stay" >&2
      echo link
    else
      echo blocked
    fi
  elif status_has unknown && [ "$(link_state "$target" "$(skills_dir_of agents)/${name}")" = foreign ]; then
    echo held
  else
    echo link
  fi
}

PLANS=""
for skill_dir in "$SCRIPT_DIR"/skills/*/; do
  [ -e "${skill_dir}SKILL.md" ] || continue
  name="$(basename "$skill_dir")"
  PLANS="${PLANS}${name} $(plan_for "$name" "${skill_dir%/}")
"
done

plan_of() {
  printf '%s' "$PLANS" | sed -n "s/^$1 //p"
}

REPO_SKILLS="$(resolve "${SCRIPT_DIR}/skills")"

for harness in $HARNESSES; do
  root="$(harness_root "$harness")"
  skills_dir="$(skills_dir_of "$harness")"
  if [ ! -d "$root" ]; then
    echo "$(harness_name "$harness"): not installed (${root} missing), skipped"
    continue
  fi
  if [ -L "$skills_dir" ] && [ ! -e "$skills_dir" ]; then
    echo "$(harness_name "$harness"): ${skills_dir} is a dangling symlink, skipped"
    continue
  fi
  if [ "$(resolve "$skills_dir")" = "$REPO_SKILLS" ]; then
    echo "$(harness_name "$harness"): ${skills_dir} is this repo's skills folder, skipped"
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
    plan="$(plan_of "$name")"
    case "$plan" in
      installed | blocked)
        case "$state" in
          own | dangling)
            rm "$link"
            if [ "$plan" = blocked ]; then
              echo "  ✗  ${link}: removed, run luxonis tick to install the Luxonis copy"
            else
              echo "  ✗  ${link}: removed, the Luxonis copy is installed"
            fi
            ;;
          *) echo "  ↷  skipping ${name}: the luxonis CLI installs it" ;;
        esac
        ;;
      held) echo "  ↷  skipping ${name}: $(skills_dir_of agents)/${name} already holds a copy" ;;
      *)
        case "$state" in
          foreign) echo "  ⚠  skipping ${link}: it holds a copy this repo did not install" ;;
          *)
            ln -sfn "$target" "$link"
            echo "  ✓  ${link} → ${target}"
            ;;
        esac
        ;;
    esac
  done
done

echo ""
echo "Done. Restart running agent sessions to pick up new skills."
