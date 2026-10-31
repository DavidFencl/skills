# Skills

Personal agent skills. Each skill is a folder under `skills/` with a `SKILL.md`, and works in any harness that loads the [Agent Skills](https://agentskills.io) format: Claude Code, Codex, pi and Grok.

| Skill | Description |
| --- | --- |
| [`design-sprint`](skills/design-sprint/SKILL.md) | Focused UI design sprint, run like an arena. Several models (Claude, Codex, Grok, pi models) build N variants of a screen, a component or a new feature from your design system as dev-only previews, plus single-property decision options. A local decisions page lets you pick, keep the current version ("Do nothing" is always offered), or re-prompt any variant, and the agent iterates until you submit. |
| [`ui-changelog`](skills/ui-changelog/SKILL.md) | Visual changelog for frontend work. Maps the git diff to the pages, states and viewports it touches, captures before/after screenshots of the real app at both refs, circles what is new or modified with numbered close-ups, and writes an HTML review report plus PR-ready Markdown. It mocks missing or unsafe backends (REST, GraphQL, WebSocket, SSE, images, third-party scripts) with realistic data drafted from the project's own types. |

## Install

```bash
git clone https://github.com/DavidFencl/skills.git ~/skills
~/skills/install-globally.sh
```

The installer symlinks each skill into `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills` and `~/.grok/skills`, for each harness that is installed, honoring `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` and `GROK_HOME` when set. It runs on bash 3.2 (macOS) and later. Re-run it after adding a skill. Pulling the repo updates installed skills in place.

## design-sprint

Invoke it with a screen or component and what to explore, or with a feature that does not exist yet (`new feature: bulk invite on the team page, 6 variants`). For a new feature, "Do nothing" means "don't add it", and the decisions appear once you pick a direction. The syntax depends on the harness: `/design-sprint` in Claude Code, `$design-sprint` in Codex, `/skill:design-sprint` in pi, and the skill name in Grok.

- **Variants from several models.** `scripts/lanes.mjs` runs the lanes in parallel, each through its own CLI in headless mode (`claude -p`, `codex exec`, `grok --prompt-file`, `pi -p`). Each lane writes only its own preview directory. Every lane gets the same brief, so the variants differ by the models' own judgment, as in an arena. When you ask for more variants than there are models, the lanes are spread over the models, and each lane of a model that builds several gets its own angle, shown on its card. A lane that fails is recorded as a dropout, never silently replaced.
- **Choosing models.** By default there is one lane per installed CLI on its default model. To pin models, write `~/.config/design-sprint/config.json`, or `.design-sprint/config.json` in a project:

  ```json
  { "models": ["claude:opus@high", "codex:gpt-6.1-sol@high", "grok:grok-4.7@high"], "variants": 6, "critic": "codex:gpt-6.1-sol@high", "blind": true }
  ```

  Each entry is `<cli>:<model>[@<effort>]`; an empty model uses that CLI's default. `blind` hides which model made each variant until you submit. `variants` sets how many variants the first round builds; the default is one per model. `node skills/design-sprint/scripts/lanes.mjs roster [--variants <n>]` prints the models and lanes a sprint will use.
- **The decisions page** is served at `http://127.0.0.1:4390/`. Preview files from the sprint directory come from a separate origin on port 4391, so preview code cannot act on the page. Your picks, re-prompts and final answer go to `.design-sprint/<slug>/feedback.jsonl`. The agent waits on that file with `scripts/wait.mjs`, sends each re-prompt back to the model that built that variant, and the open page shows the result within two seconds.

Everything needs only Node. `node --test skills/design-sprint/scripts/*.test.mjs` runs the skill's tests. The formats are in [`references/manifest.md`](skills/design-sprint/references/manifest.md) and [`references/lane-prompt.md`](skills/design-sprint/references/lane-prompt.md).

## ui-changelog

Ask the agent for "a UI changelog of my changes" or "before/after screenshots for this branch". The agent then:

1. Runs `scripts/affected.mjs` to map changed files to the pages, routes and layouts that render them, with route hints, responsive signals and the viewports to capture. `--manifest` writes a capture manifest skeleton that already lists every changed UI file.
2. Serves the base ref from a git worktree and your changes from the checkout, on two free ports.
3. When no safe backend exists, points the app at a closed port, captures once, and runs `scripts/mocks.mjs draft` to write mocks for every unanswered call, typed from the project's own TypeScript or JSDoc types.
4. Runs `scripts/capture.mjs`, which captures each pair with Playwright under identical settings, compares them, and writes the report.

The report directory, by default `~/.local/state/ui-changelog/<repo>/<timestamp>/`, contains:

| File | Contents |
| --- | --- |
| `index.html` | A Needs attention list (unexpected results, unanswered API calls, errors only on the after side, changed files with no shot), coverage of the changed files, and changed rows with Before, After, Circled changes and Diff, numbered close-ups and a swipe view, plus new and removed UI. Unchanged checks are listed by name. |
| `report.md` | The same as Markdown tables with relative image paths, ready for `gh pr edit --attach`. |
| `results.json`, `unanswered.json`, `shots/`, `manifest.json` | Raw results, the endpoints that got no answer (query and body values redacted), PNGs, and the manifest used (credentials redacted). |

The circled view aligns rows like a text diff, so content that only moved is not circled. Playwright, pngjs and pixelmatch are installed by `scripts/setup.sh` into `~/.cache/ui-changelog`, never into the project under review. Requires Node 22.12 or newer.

The manifest format is in [`references/manifest.md`](skills/ui-changelog/references/manifest.md), and the mocking playbook in [`references/mocking.md`](skills/ui-changelog/references/mocking.md).

## Development

```bash
node --test tests/*.test.mjs skills/*/scripts/*.test.mjs   # every test; browser tests need setup.sh
node tests/check-portability.mjs                            # frontmatter, prose and loader checks for every harness installed
```

Set `UI_CHANGELOG_TYPESCRIPT` to a `typescript` package directory (TypeScript 6 or older; 7 has no JavaScript compiler API) to run the type-reading tests. CI (`.github/workflows/test.yml`) runs both commands on every pull request with Chromium and TypeScript installed, on Node 22.12 and 24, and fails if any test is skipped. Harness loader checks in `check-portability.mjs` are skipped there because no harness is installed. Agent-level test cases live in `skills/ui-changelog/evals/` in the skill-creator format (`prompt.md`, `case.yaml`, `graders/`, a scaffold script), and `evals/trigger-queries.json` holds should-trigger and should-not-trigger prompts for tuning the description.
