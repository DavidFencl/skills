# Skills

Personal agent skills. Each skill is a folder under `skills/` with a `SKILL.md`, and works in any harness that loads that format (Claude Code, Codex, pi, Grok).

| Skill | Description |
| --- | --- |
| [`design-sprint`](skills/design-sprint/SKILL.md) | Focused UI design sprint, run like an arena. Several models (Claude, Codex, Grok, pi models) each build their own variant of a screen or component from your design system as dev-only previews, plus single-property decision options. A local decisions page lets you pick, keep the current version ("Do nothing" is always offered), or re-prompt any variant, and the agent iterates until you submit. |
| [`ui-changelog`](skills/ui-changelog/SKILL.md) | Visual changelog for frontend work. Maps the git diff to the pages and states it touches, captures before/after screenshots of the real app at both refs, at every viewport the change affects, circles what is new or modified, and writes an HTML report plus PR-ready Markdown. It can mock API responses, so screens show realistic data when no safe backend is available. |

## Install

```bash
git clone https://github.com/DavidFencl/skills.git ~/skills
~/skills/install-globally.sh
```

The installer symlinks each skill into `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills` and `~/.grok/skills`, for each harness that is installed. It runs on bash 3.2 (macOS) and later. Re-run it after adding a skill. Pulling the repo updates installed skills in place.

## design-sprint

Invoke it with a screen or component and what to explore. The syntax depends on the harness: `/design-sprint` in Claude Code, `$design-sprint` in Codex, `/skill:design-sprint` in pi, and the skill name in Grok.

- **Variants from several models.** `scripts/lanes.mjs` runs one lane per model in parallel, each through its own CLI in headless mode (`claude -p`, `codex exec`, `grok --prompt-file`, `pi -p`). Each lane writes only its own preview directory. Every lane gets the same brief, so the variants differ by the models' own judgment, as in an arena. A lane that fails is recorded as a dropout, never silently replaced.
- **Choosing models.** By default there is one lane per installed CLI on its default model. To pin models, write `~/.config/design-sprint/config.json`, or `.design-sprint/config.json` in a project:

  ```json
  { "models": ["claude:opus@high", "codex:gpt-6.1-sol@high", "grok:grok-4.7@high"], "critic": "codex:gpt-6.1-sol@high", "blind": true }
  ```

  Each entry is `<cli>:<model>[@<effort>]`; an empty model uses that CLI's default. `blind` hides which model made each variant until you submit. `node skills/design-sprint/scripts/lanes.mjs roster` prints the models a sprint will use.
- **The decisions page** is served at `http://127.0.0.1:4390/`. Preview files from the sprint directory come from a separate origin on port 4391, so preview code cannot act on the page. Your picks, re-prompts and final answer go to `.design-sprint/<slug>/feedback.jsonl`. The agent waits on that file with `scripts/wait.mjs`, sends each re-prompt back to the model that built that variant, and the open page shows the result within two seconds.

Everything needs only Node. `node --test skills/design-sprint/scripts/*.test.mjs` runs the skill's tests. The formats are in [`references/manifest.md`](skills/design-sprint/references/manifest.md) and [`references/lane-prompt.md`](skills/design-sprint/references/lane-prompt.md).

## ui-changelog

Ask the agent for "a UI changelog of my changes" or "before/after screenshots for this branch". The agent then:

1. Runs `scripts/affected.mjs` to map changed files to the pages, routes and layouts that render them, and to flag responsive code (breakpoint variants, `@media` queries, viewport hooks) with the viewports to capture.
2. Serves the base ref from a git worktree and your changes from the checkout, on two free ports.
3. Writes a capture manifest with the locations and states to capture, and any API mocks.
4. Runs `scripts/capture.mjs`, which captures each pair with Playwright under identical settings, compares them, and writes the report.

The report directory, by default `~/.local/state/ui-changelog/<repo>/<timestamp>/`, contains:

| File | Contents |
| --- | --- |
| `index.html` | Changed rows with Before, After, Circled changes and Diff columns, plus new and removed UI. Unchanged checks are listed by name. |
| `report.md` | The same as Markdown tables with relative image paths, ready for `gh pr edit --attach`. |
| `results.json`, `shots/` | Raw results and PNGs. |

The circled view aligns rows like a text diff, so content that only moved is not circled. Playwright, pngjs and pixelmatch are installed by `scripts/setup.sh` into `~/.cache/ui-changelog`, never into the project under review. Requires Node 22.12 or newer.

The manifest format is documented in [`references/manifest.md`](skills/ui-changelog/references/manifest.md).
