# Skills

Personal agent skills. Each skill is a folder under `skills/` with a `SKILL.md`, and works in any harness that loads that format (Claude Code, Codex, pi, Grok).

| Skill | Description |
| --- | --- |
| [`ui-changelog`](skills/ui-changelog/SKILL.md) | Visual changelog for frontend work. Maps the git diff to the pages and states it touches, captures before/after screenshots of the real app at both refs, circles what is new or modified, and writes an HTML report plus PR-ready Markdown. It can mock API responses, so screens show realistic data when no safe backend is available. |

## Install

```bash
git clone https://github.com/DavidFencl/skills.git ~/skills
~/skills/install-globally.sh
```

The installer symlinks each skill into `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills` and `~/.grok/skills`, for each harness that is installed. Re-run it after adding a skill. Pulling the repo updates installed skills in place.

## ui-changelog

Ask the agent for "a UI changelog of my changes" or "before/after screenshots for this branch". The agent then:

1. Runs `scripts/affected.mjs` to map changed files to the pages, routes and layouts that render them.
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
