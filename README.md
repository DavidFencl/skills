# Skills

Personal agent skills. Each skill is a folder under `skills/` with a `SKILL.md`, and works in any harness that loads the [Agent Skills](https://agentskills.io) format: Claude Code, Codex, pi and Grok.

| Skill | Description |
| --- | --- |
| [`ui-changelog`](skills/ui-changelog/SKILL.md) | Visual changelog for frontend work. Maps the git diff to the pages, states and viewports it touches, captures before/after screenshots of the real app at both refs, circles what is new or modified with numbered close-ups, and writes an HTML review report plus PR-ready Markdown. It mocks missing or unsafe backends (REST, GraphQL, WebSocket, SSE, images, third-party scripts) with realistic data drafted from the project's own types. |

## Install

```bash
git clone https://github.com/DavidFencl/skills.git ~/skills
~/skills/install-globally.sh
```

The installer symlinks each skill into `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills` and `~/.grok/skills`, for each harness that is installed. Re-run it after adding a skill. Pulling the repo updates installed skills in place.

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
| `results.json`, `unanswered.json`, `shots/`, `manifest.json` | Raw results, the endpoints that got no answer, PNGs, and the manifest used. |

The circled view aligns rows like a text diff, so content that only moved is not circled. Playwright, pngjs and pixelmatch are installed by `scripts/setup.sh` into `~/.cache/ui-changelog`, never into the project under review. Requires Node 22.12 or newer.

The manifest format is in [`references/manifest.md`](skills/ui-changelog/references/manifest.md), and the mocking playbook in [`references/mocking.md`](skills/ui-changelog/references/mocking.md).

## Development

```bash
node --test tests/ui-changelog.test.mjs     # script tests; browser tests need setup.sh
node tests/check-portability.mjs            # frontmatter, prose and loader checks for every harness installed
```

Set `UI_CHANGELOG_TYPESCRIPT` to a `typescript` package directory to run the type-reading tests. Agent-level test cases live in `skills/ui-changelog/evals/` in the skill-creator format (`prompt.md`, `case.yaml`, `graders/`, a scaffold script), and `evals/trigger-queries.json` holds should-trigger and should-not-trigger prompts for tuning the description.
