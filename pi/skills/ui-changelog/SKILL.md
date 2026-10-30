---
name: ui-changelog
description: Builds a visual changelog of frontend work. Maps the git diff to the pages and UI states it touches, captures before/after screenshots from the real running app at the base and changed code, pixel-diffs every pair, and writes an HTML review report plus PR-ready Markdown. This skill should be used when the user asks for before/after screenshots, a visual diff, a UI changelog, screenshots for a PR, "show me what changed in the UI", or wants to review frontend changes visually, even when they don't say "changelog".
---

# UI changelog

The deliverable is a report directory a reviewer can open and scan:

- `index.html` has one row per location and state, with Before, After and Diff columns, grouped as changed, added, removed, failed and unchanged.
- `report.md` holds the same pairs as Markdown tables with relative image paths, ready for `gh --attach`.
- `results.json` and `shots/` hold the raw data.

Scripts live in `scripts/` next to this file:

- `affected.mjs` maps the diff to the UI entry points it reaches. It needs only Node.
- `capture.mjs` turns a manifest into screenshots, diffs and the report. Field reference: [references/manifest.md](references/manifest.md).
- `setup.sh` installs Playwright, pngjs and pixelmatch into `~/.cache/ui-changelog`, never into the project. It is idempotent, so run it before the first capture of a session.

Default report location: `${XDG_STATE_HOME:-$HOME/.local/state}/ui-changelog/<repo>/<YYYYMMDD-HHMM>/`.

## 1. Read the project's rules

The project's instruction files (`AGENTS.md`, `CLAUDE.md`, a run or browser-verify skill) decide how to start servers, which ports and accounts to use, and which data is safe to touch. They override this skill. If a dev server may reach production data, capture only read-only states, never submit writes, and use the project's isolated stack for anything else. Do not restart or reconfigure servers the developer already runs.

## 2. Pick the two refs

| Situation | Before | After |
| --- | --- | --- |
| Uncommitted work | `HEAD` | working tree |
| Branch with commits | merge-base with the PR base (`gh pr view --json baseRefName`, else the default branch) | working tree |
| PR not checked out | PR base | PR head |

Put both refs in the manifest `title` and in each side's `ref`.

## 3. Map the diff to screens

```bash
node <skill-dir>/scripts/affected.mjs --markdown --base <ref> --scope <frontend-dir> [--scope <shared-lib-dir>]
```

Run it from inside the repository under review. Without `--base` it uses `HEAD` when the tree is dirty, otherwise the merge-base with `origin/HEAD`. `--scope` limits it to frontend paths, given relative to the current directory or the repo root. `--entry <regex>` replaces the built-in entry patterns (pages, routes, views, screens, layouts, routers) when the framework uses other conventions. Drop `--markdown` for JSON with full import chains.

Handle each group like this:

- **Scoped.** Find each entry's URL in the router config.
- **App shell.** The file renders on every page. Capture one representative page per layout that includes it.
- **Global.** Locale files, tokens, theme files and barrels reach most of the app. Read the diff hunks for the exact keys, tokens or exports that changed, grep for their consumers, and capture those screens. Never screenshot every page.
- **Unreached.** Read the file. It may be loaded dynamically, use an undetected convention (rerun with `--entry`), or not be UI at all.

The import graph says where a change renders. The hunks say which state shows it. For each location, list the states the change affects: default, hover or focus, open menu, dialog or drawer, empty, loading, error, validation, the mobile breakpoint when responsive code changed, dark theme when theme code changed, and a long-text locale when copy changed. Each location and state pair becomes one shot. Mark a shot of UI that does not exist on the base with `"new": true`, and UI the change deletes with `"removed": true`. Any other shot that fails on one side is reported as failed, so a broken selector cannot pass as new UI.

Add one control shot the diff should not affect. When the app shell changed, the control is an element outside the shell, such as the page's `main`, with no `padding` that reaches into the shell.

## 4. Serve both sides

1. **After.** Use the current checkout when it is the after ref. Otherwise create a worktree for it as for before.
2. **Before.** Run `git worktree add --detach <before-dir> <before-ref>`, where `<before-dir>` is a fresh temporary directory outside the repository, such as `$(mktemp -d)/before`. Install dependencies the project's way with a frozen lockfile, and start the same dev command.
3. **Ports.** Use two free, non-default ports. Pass `--port <n> --strictPort --host 127.0.0.1` to Vite and the equivalent elsewhere, and put the URL each server prints into the manifest. Vite binds `localhost`, which may be IPv6 only, so without `--host` a `127.0.0.1` URL can be refused. Set any API base URL or CORS variables the project requires for an agent-started frontend.
4. **Same inputs.** Point both sides at the same backend, data, account, feature flags and env, so the frontend code is the only variable. When the diff also changes the API, run each side against its own backend only if the project's rules allow it. Otherwise say in the report that before shots run against the new API.
5. **Fidelity.** Capture real app routes. Use a story or harness only when no route renders the component, and add `(story)` to the label. Never inject CSS or edit the DOM to imitate a change. Stubbing API responses is acceptable when the project allows it.

## 5. Write the manifest and capture

```json
{
  "title": "feat/report-button vs development",
  "before": { "baseURL": "http://127.0.0.1:5301", "ref": "development 6db915d" },
  "after": { "baseURL": "http://127.0.0.1:5302", "ref": "working tree" },
  "viewport": { "width": 1280, "height": 800 },
  "fixedTime": "2026-01-15T10:00:00Z",
  "mask": ["[data-testid=clock]"],
  "waitForHidden": [".spinner"],
  "shots": [
    { "id": "footer", "label": "Home › footer", "path": "/", "selector": "footer", "padding": 16, "sources": ["src/components/layout/footer.tsx"] },
    { "id": "report-dialog", "label": "Home › footer › Report a problem, open", "path": "/", "new": true, "steps": [{ "click": "role=button[name=\"Report a problem\"]" }], "selector": "role=dialog", "padding": 16 },
    { "id": "error-mobile", "label": "Route error page, mobile", "path": "/does-not-exist", "viewport": { "width": 390, "height": 844 } },
    { "id": "about-control", "label": "About (control)", "path": "/about", "note": "Not in the diff. Expected unchanged." }
  ]
}
```

```bash
bash <skill-dir>/scripts/setup.sh
node <skill-dir>/scripts/capture.mjs <manifest.json> --out <report-dir>
```

When pages need a login, follow the project's account rules. If the user should log in themselves, run `node <skill-dir>/scripts/capture.mjs login <after-baseURL> <state.json>`. It opens a browser, and the session is saved when they close the window. Set `storageState` to that file. The state file is a credential, so keep it outside every repository and delete it when done.

Make the pairs comparable. Use the same viewport, theme, locale and timezone on both sides, `fixedTime` for relative dates, `mask` for clocks, avatars, random IDs and live maps, and `waitForHidden` for spinners. Prefer element shots with `padding` over full pages, so a reader sees the change and enough context to place it.

## 6. Check every pair before handing over

Open the changed, added and removed images and look at them.

| Result | Action |
| --- | --- |
| `unchanged` where the diff should show | Wrong location or state. Fix the shot. |
| `changed` on a control or unrelated area | Nondeterminism or a real regression. Mask or pin the noise and recapture. If it persists, report it as a regression. |
| `failed` | Fix the selector or steps. If the state is unreachable, keep the row and give the reason. |
| `added` | The shot is marked `new`. Confirm the after image shows the new UI. |

Recapture only the fixed shots with `--only <id>,<id>`. Results merge into the existing report. `capture.mjs report --out <dir>` re-renders the HTML and Markdown without capturing.

## 7. Hand over and clean up

1. Give the path to `index.html`, and open it when the user is on this machine (`xdg-open` or `open`).
2. Summarize the counts, one line per changed location, any unexpected diffs, every location not captured with its reason, and the two refs.
3. Attach images to a PR only when the user asks. Run `gh pr edit <n> --body-file <report-dir>/report.md --attach ./shots/<file>.png ...` from inside the report directory, so the attach paths match the Markdown references. This needs gh 2.99 or newer. On an older gh, say so and leave the report local.
4. Stop the servers you started. Remove the before worktree the way the host's rules require (`git worktree remove <path>` by default). Delete the storage state. Keep the report directory.
