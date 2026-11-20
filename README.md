# Skills

Personal agent skills. Each skill is a folder under `skills/` with a `SKILL.md`, and works in any harness that loads the [Agent Skills](https://agentskills.io) format: Orca, Claude Code, Codex, pi and Grok.

| Skill | Description |
| --- | --- |
| [`add-frontend`](skills/add-frontend/SKILL.md) | Adds a custom web page to a DepthAI v3 (Luxonis OAK camera) Python app. It copies a React and Vite template built on `@luxonis/depthai-viewer-common` and `@luxonis/ui-components`, adds one control per Python service, and edits the Python code so the app serves the page in peripheral mode, while `oakapp.toml` serves it on an OAK4 in standalone mode. |
| [`ui-changelog`](skills/ui-changelog/SKILL.md) | Visual changelog for frontend work. Maps the git diff to the pages, states and viewports it touches, captures before/after screenshots of the real app at both refs, circles what is new or modified with numbered close-ups, and writes an HTML review report plus PR-ready Markdown. It mocks missing or unsafe backends (REST, GraphQL, WebSocket, SSE, images, third-party scripts) with realistic data drafted from the project's own types. |

## Install

```bash
git clone https://github.com/DavidFencl/skills.git ~/skills
~/skills/install-globally.sh
```

The installer symlinks each skill into the folders the `luxonis` CLI installs into. These are `~/.agents/skills`, which Orca, Codex and pi read, plus `~/.claude/skills` and `~/.grok/skills` for each harness that is installed, honoring `CLAUDE_CONFIG_DIR` and `GROK_HOME` when set. It removes its own earlier links from `~/.codex/skills` and `~/.pi/agent/skills`, which would show Codex and pi a second copy. It runs on bash 3.2 (macOS) and later. Re-run it after adding a skill. Pulling the repo updates installed skills in place.

The Luxonis version of a skill always wins. The installer reads `luxonis skills status`, which lists the skills the CLI installed on this machine and the pack skills it skipped because another copy held the name. It removes its own links to a skill the CLI installed. For a skipped pack skill, it removes its own links, runs `luxonis tick`, and links its copy again only if the CLI still did not install the pack's copy. The installer changes only its own links and dangling links, so it never replaces the CLI's copies or any other copy already in place.

## add-frontend

Ask the agent to "add a frontend to this OAK app" in a DepthAI v3 app. The agent then:

1. Reads the app: its entry script, the topics and services it registers with `RemoteConnection`, and its `oakapp.toml`.
2. Checks the `@luxonis/*` versions that `luxonis/oak-examples` pins today, through the Luxonis Context MCP server or `gh`.
3. Runs `scripts/scaffold.mjs`, which copies the template to `frontend/`, writes `frontend_server.py` next to the entry script, and adds `[static_frontend]` to `oakapp.toml`.
4. Edits the Python app to call `serve_frontend()` and to pass `serveFrontend=False`, then builds one control per service on the page.
5. Builds the page and runs `scripts/check.mjs`, which fails when the Python app and the page disagree on a stream or service name, or when either mode would serve no page.

In peripheral mode the app serves the page at `http://localhost:8082`. On an OAK4 in standalone mode, the `luxonis/oakapp-base` image serves it. The template is derived from `custom-frontend/raw-stream` in `luxonis/oak-examples` (Apache-2.0); see [`assets/NOTICE`](skills/add-frontend/assets/NOTICE). Details are in [`references/frontend.md`](skills/add-frontend/references/frontend.md) and [`references/standalone.md`](skills/add-frontend/references/standalone.md).

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
