# Skills

A personal collection of agent skills and extensions for coding and related tasks.

Skills under [`skills/`](skills) are harness-neutral: they work in Claude Code, Codex, [pi](https://github.com/earendil-works/pi-coding-agent) and Grok, and the installer links them into each one you have. Skills under [`pi/skills/`](pi/skills) are pi-only for now; move a skill to `skills/` once it no longer depends on pi.

The pi skills implement a **plan → implement → review** workflow for feature work:

1. **`plan`** — a strong model interrogates you about scope, edge cases, types, design conventions, and testing criteria, then writes a test-driven plan of sequential atomic steps and audits it.
2. **`implement`** — a cheap model executes one step at a time with strict test-driven verification, strict file scoping, and automatic retry/escalation when a step fails.
3. **`review`** — a strong model holistically reviews the finished feature against the plan: design coherence, accessibility, and full project checks. Approves it or converts findings into new fix steps for `implement`.

The [`skill-thinking`](pi/extensions/skill-thinking.ts) extension ties it together: it switches model + thinking level automatically per skill and offers to start the review when the last step completes.

## Contents

### Harness-neutral skills (`skills/`)

| Skill | Description |
|-------|-------------|
| [`design-sprint`](skills/design-sprint/SKILL.md) | Focused UI design sprint, run like an arena: several models (Claude, Codex, Grok, pi models) each build their own variant of a screen or component from your design system as dev-only previews, plus single-property decision options. Opens a local decisions page where you pick, keep the current version ("Do nothing" is always offered) or re-prompt any variant, and iterates until you submit. |

### pi-only skills (`pi/skills/`)

| Skill | Description |
|-------|-------------|
| [`plan`](pi/skills/plan/SKILL.md) | Senior Software Architect / Planner & QA Agent. Discovers the codebase (including your design system: styling approach, component library, design tokens), grills you with 3–5 questions at a time, drafts a `PLAN-<feature>.md` of sequential atomic steps with baseline/verification commands, and runs an automated audit pass. |
| [`implement`](pi/skills/implement/SKILL.md) | Test-Driven Executor Agent. Executes one step, runs the baseline check before editing and the verification command after, stays strictly within the step's files, flips the step's status to `done`, and logs post-mortem learnings to `.pi/learnings.md`. |
| [`review`](pi/skills/review/SKILL.md) | Holistic reviewer & design guardian. Checks the finished feature against the plan and your existing UI patterns, runs full typecheck/lint/tests, then appends an `APPROVE` verdict or adds `F1..Fn` fix steps to the plan. |

### Design sprint

Invoke it with a screen or component and what to explore. The syntax depends on the harness: `/design-sprint` in Claude Code, `$design-sprint` in Codex, `/skill:design-sprint` in pi, and the skill name in Grok.

- **Variants from several models.** `scripts/lanes.mjs` runs one lane per model in parallel, each through its own CLI in headless mode (`claude -p`, `codex exec`, `grok --prompt-file`, `pi -p`). Each lane writes only its own preview directory. Every lane gets the same brief, so the variants differ by the models' own judgment, as in an arena. A lane that fails is recorded as a dropout, never silently replaced.
- **Choosing models.** By default there is one lane per installed CLI on its default model. To pin models, write `~/.config/design-sprint/config.json`, or `.design-sprint/config.json` in a project:

  ```json
  { "models": ["claude:opus@high", "codex:gpt-6.1-sol@high", "grok:grok-4.7@high"], "critic": "codex:gpt-6.1-sol@high", "blind": true }
  ```

  Each entry is `<cli>:<model>[@<effort>]`; an empty model uses that CLI's default. `blind` hides which model made each variant until you submit. `node skills/design-sprint/scripts/lanes.mjs roster` prints the models a sprint will use.
- **The decisions page** is served at `http://127.0.0.1:4390/`. Preview files from the sprint directory come from a separate origin on port 4391, so preview code cannot act on the page. Your picks, re-prompts and final answer go to `.design-sprint/<slug>/feedback.jsonl`. The agent waits on that file with `scripts/wait.mjs`, sends each re-prompt back to the model that built that variant, and the open page shows the result within two seconds.

Everything needs only Node. `node --test skills/design-sprint/scripts/*.test.mjs` runs the skill's tests. The formats are in [`references/manifest.md`](skills/design-sprint/references/manifest.md) and [`references/lane-prompt.md`](skills/design-sprint/references/lane-prompt.md).

### Extensions

| Extension | Description |
|-----------|-------------|
| [`skill-thinking`](pi/extensions/skill-thinking.ts) | Applies a per-skill profile on invocation (model + thinking level, e.g. plan → strong model/high, implement → cheap model/low). When an implement run finishes the last step, offers to chain straight into `/skill:review`. Restores your default model/thinking on exit. |

## Requirements

- One or more of Claude Code, Codex, pi and Grok. The skills in `pi/skills/` and the extension need [pi](https://github.com/earendil-works/pi-coding-agent).
- Node.js for the scripts bundled with `design-sprint`.
- The project you use them in should have its own test/type-check tooling (`tsc`, `vitest`, `pytest`, etc.); the skills discover it rather than bundle it.

## Installation

**Quickest:** run the installer script. It links `skills/*` into every installed harness (`~/.claude/skills`, `~/.codex/skills`, `~/.grok/skills`, `~/.pi/agent/skills`), and links `pi/skills/*` and the pi extension into pi:

```bash
./install-globally.sh
```

Restart your harness, or run `/reload` in pi. The manual methods below cover the pi-only skills.

Pick one method. The symlink approach is recommended because it makes updates automatic.

### Option 1: Global symlinks (recommended)

Clone this repo once, then symlink the skill directories into pi's global skills folder:

```bash
git clone <this-repo-url> ~/skills
mkdir -p ~/.pi/agent/skills
ln -s ~/skills/pi/skills/plan ~/.pi/agent/skills/plan
ln -s ~/skills/pi/skills/implement ~/.pi/agent/skills/implement
ln -s ~/skills/pi/skills/review ~/.pi/agent/skills/review
```

Pi discovers directories containing `SKILL.md` recursively under `~/.pi/agent/skills/`, so all skills become available in every project.

### Option 2: Global settings

Point pi's `skills` setting at this repo (or at the individual skill directories) in `~/.pi/agent/settings.json`:

```json
{
  "skills": ["~/skills/pi/skills"]
}
```

### Option 3: Per-project

Symlink or copy the skill directories into a specific project:

```bash
mkdir -p /path/to/project/.pi/skills
ln -s ~/skills/pi/skills/plan /path/to/project/.pi/skills/plan
ln -s ~/skills/pi/skills/implement /path/to/project/.pi/skills/implement
ln -s ~/skills/pi/skills/review /path/to/project/.pi/skills/review
```

> **Note:** project-local `.pi/skills/` only load after the project is trusted. Run `/trust` in pi, or pass `--approve`.

### Option 4: One-off via CLI

```bash
pi --skill ~/skills/pi/skills/plan --skill ~/skills/pi/skills/implement --skill ~/skills/pi/skills/review
```

## Extension installation

Symlink the extension into pi's global extensions folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s ~/skills/pi/extensions/skill-thinking.ts ~/.pi/agent/extensions/
```

Restart pi (or run `/reload`).

## Configuration (skill-thinking)

The extension works out of the box with sensible defaults; all of it can be overridden via optional JSON config files — no code edits needed.

### Files & precedence

| File | Scope |
|------|-------|
| `~/.pi/agent/skill-thinking.json` | Global (all projects) |
| `<project>/.pi/skill-thinking.json` | Project-local (wins) |

Precedence: **built-in defaults < global < project**. Configs are merged per skill, so a project file can override just one skill's model while inheriting everything else. Changes apply on the next session start or `/reload`.

### Options reference

| Option | Type | Values | Description |
|--------|------|--------|-------------|
| `profiles.<skill>.model` | string \| null | `"provider/modelId"` | Model to switch to when `/skill:<skill>` runs. `null` disables model switching for that skill (thinking still applies). Omit the key to inherit. |
| `profiles.<skill>.thinking` | string | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | Thinking level for that skill, clamped to the model's supported levels. Required when adding a profile for a skill not in the defaults. |
| `autoReview` | string | `"off"` \| `"ask"` \| `"auto"` | What happens when an implement run finishes the last plan step: nothing, confirm before chaining into `/skill:review`, or chain silently. Default: `"ask"`. |

### Built-in defaults

| Skill | Model | Thinking |
|-------|-------|----------|
| `plan` | `opencode-go/kimi-k3` | `max` |
| `implement` | `opencode-go/deepseek-v4-flash` | `low` |
| `review` | `opencode-go/deepseek-v4-pro` | `high` |

### Example

```json
{
  "profiles": {
    "plan":      { "model": "opencode-go/kimi-k3", "thinking": "max" },
    "implement": { "thinking": "low" },
    "review":    { "model": null, "thinking": "high" },
    "my-skill":  { "thinking": "medium" }
  },
  "autoReview": "auto"
}
```

This pins planning to kimi-k3, keeps the default implement model but forces low thinking, disables model switching for review, and adds a profile for a custom `my-skill`.

Invalid values produce a warning notification and are ignored; a malformed JSON file never breaks the extension — the built-in defaults always survive.

### Behavior notes

- Thinking levels are clamped to model capabilities (e.g. `kimi-k3` supports `max` only, so a `high` request becomes `max`); the extension reports the effective level.
- If you change the model manually mid-session (`/model`, Ctrl+P, or a `pi --model ...` escalation launch), profile model switching backs off for that session.
- Pi persists model/thinking changes to settings, so the extension restores your session-start defaults on exit.

## Usage

### 1. Plan the work

```
pi /skill:plan
```

With the extension installed this auto-selects the strong model + high thinking; otherwise run it explicitly with a strong model (`pi --model <stronger-model-id> /skill:plan`). The planner explores the project, asks clarifying questions, drafts `PLAN-<feature>.md`, and audits it.

### 2. Implement step by step

```
pi /skill:implement PLAN-<feature>.md
```

Runs the first `pending` step (auto-selects the cheap model + low thinking with the extension). Repeat until done; target a specific step with `pi /skill:implement PLAN-<feature>.md <N>`. A step that fails twice stops and escalates with a `BLOCKED` entry in `.pi/learnings.md` and a stronger-model command.

### 3. Review the finished feature

```
pi /skill:review PLAN-<feature>.md
```

The extension offers this automatically when the last step completes. The reviewer appends its verdict to the plan: `APPROVE`, or `CHANGES_REQUESTED` plus new `F1..Fn` fix steps — which you then run through the same implement loop.

### Artifacts produced

| Path | Purpose |
|------|---------|
| `PLAN-<feature>.md` | The step-by-step plan with per-step status tracking, audit log, signature, and final review verdict |
| `.pi/learnings.md` | Post-mortem notes and `BLOCKED` entries from failed steps, used to improve future plans |

## Repository layout

```
.
├── pi/
│   ├── extensions/
│   │   └── skill-thinking.ts
│   └── skills/
│       ├── implement/
│       │   └── SKILL.md
│       ├── plan/
│       │   └── SKILL.md
│       └── review/
│           └── SKILL.md
└── README.md
```

## Roadmap / ideas

- Add a `retro` skill that turns accumulated `.pi/learnings.md` entries into planner rules.
- Visual verification for UI steps (e.g. Playwright screenshots checked by the reviewer).
- Optional per-step commits so every step is a reviewable, revertable unit.
- Add a LICENSE.

## License

TBD — add a license before sharing publicly.
