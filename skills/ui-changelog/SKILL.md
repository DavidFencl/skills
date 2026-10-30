---
name: ui-changelog
description: Builds a reviewable visual changelog of frontend changes. Maps the git diff to the pages, states and viewports it touches, captures before/after screenshots of the real running app at both refs, circles what is new or modified with numbered close-ups, and writes an HTML review report plus PR-ready Markdown. Mocks missing or unsafe backends (REST, GraphQL, WebSocket, SSE, images, third-party scripts) with realistic data drafted from the project's own types. This skill should be used when the user asks for before/after screenshots, a visual diff, a UI changelog or screenshots for a PR, wants to review or show frontend changes visually ("show me what changed in the UI", "what does this look like now"), or needs pages rendered with mocked API data for a review, even if they never say "changelog".
compatibility: Requires git, bash and Node.js 22.12 or newer. scripts/setup.sh installs Playwright with Chromium, pngjs and pixelmatch into ~/.cache/ui-changelog, never into the project. Drafting mocks from types uses the project's own TypeScript compiler when it has one.
metadata:
  version: "2.0.0"
---

# UI changelog

A reviewer should see what changed visually, where, and in which states, and be able to trust that nothing was missed or faked. To get there, capture every affected location and state from the real app at both refs under identical inputs, compare the pairs, and hand over a report that explains itself.

The report directory holds:

- `index.html`: counts, a **Needs attention** list, the changed files each shot covers, and one row per changed shot with Before, After, Circled changes, Diff, numbered close-ups of each change and a swipe view. New and removed UI shows as one image, failures show their errors, and unchanged shots are listed by name. Each row's capture details list the URL, steps, hidden and masked elements, and the mocks that answered.
- `report.md`: the same as Markdown tables for a PR; `results.json`, `unanswered.json`, `shots/`, and a copy of the manifest.

Placeholders used below:

- `<skill-dir>`: the directory that contains this SKILL.md. The scripts are in `<skill-dir>/scripts/`, and each prints its usage with `--help`.
- `<report-dir>`: `${XDG_STATE_HOME:-$HOME/.local/state}/ui-changelog/<repo>/<YYYYMMDD-HHMM>/` unless the user names another place. Create it first, and keep the manifest and mock files in it too: they stay outside every repository and travel with the report.
- `<before-ref>`, `<before-dir>`, `<frontend-dir>`: chosen in steps 2 to 4.

Read these when the step calls for them:

- `references/manifest.md`: every manifest field, step type and result status. Read it before writing the manifest.
- `references/mocking.md`: the mocking playbook and every mock option, including GraphQL, WebSocket, SSE, images, third-party scripts, stateful flows and server-side rendering. Read it when no safe backend exists, or when a page shows errors, skeletons or empty states that real data would fill.
- `references/troubleshooting.md`: symptoms and fixes for noisy pairs, failed shots, missing mobile layouts and dev-server quirks. Read it when a result looks wrong.

## 1. Read the project's rules

The project's instruction files (`AGENTS.md`, `CLAUDE.md`, a run or browser-verification skill) decide how to start servers, which ports and accounts to use, and which data is safe to touch. They override this skill. Dev servers often reach production data, so capture only read-only states, never submit writes against a shared backend, and use the project's isolated stack or mocks for anything else. Do not restart or reconfigure servers the developer already runs. If the project forbids ad-hoc browser scripts, `capture.mjs` counts as one: tell the user, and run it only with their go-ahead, against isolated or fully mocked targets.

## 2. Pick the two refs

| Situation | Before | After |
| --- | --- | --- |
| Uncommitted work | `HEAD` | working tree |
| Branch with commits | merge-base with the PR base (`gh pr view --json baseRefName`, else the default branch) | working tree |
| PR not checked out | PR base | PR head |

## 3. Map the diff to locations, states and viewports

Run from inside the repository under review:

```bash
node <skill-dir>/scripts/affected.mjs --markdown --base <before-ref> --scope <frontend-dir>
node <skill-dir>/scripts/affected.mjs --manifest --base <before-ref> --scope <frontend-dir> > <report-dir>/manifest.json
```

`--scope` limits the analysis to frontend paths (repeat it for shared libraries). `--entry <regex>` replaces the built-in entry patterns when the framework uses other conventions. The Markdown groups changed files like this:

- **Scoped**: the pages that import the file, each with a route hint (`at /orders/:id`) read from the router config or from file-based routing. Confirm the hint in the router before trusting it.
- **App shell**: renders on every page. Capture one representative page per layout that includes it.
- **Global**: locale files, tokens, themes and barrels that reach most of the app. Read the diff hunks for the exact keys, tokens or exports that changed, find their consumers, and capture those screens. Never screenshot every page.
- **Unreached**: read the file. It may be loaded dynamically, follow an undetected convention (rerun with `--entry`), or not be UI at all.
- **Responsive**: breakpoint variants, `@media` width queries or viewport hooks in the changed files. A signal in the changed lines means the change differs by viewport, so capture every suggested viewport. A signal elsewhere in the file means the change sits in a responsive layout, so capture mobile and desktop.

The import graph says where a change renders; the diff hunks say which state shows it. For each location, list the states the change affects: default, hover or focus, open menu, dialog or drawer, empty, loading, error, validation, dark theme when theme code changed, and a long-text locale when copy changed. Viewports multiply these states. Each location and state pair becomes one shot. Mark UI that does not exist on the base with `"new": true` and UI the change deletes with `"removed": true`; any other shot that fails on one side is reported as failed, so a broken selector cannot pass as new UI.

The `--manifest` skeleton starts the manifest: `changedFiles`, one shot per entry with its `sources` and route hint, the suggested `viewports`, `expect` on every shot, and a control shot. Fill in every `TODO`; `capture.mjs` refuses to run while one remains. Keep `changedFiles` and `sources` accurate, and give each changed file you do not capture a `notCaptured` reason: the report then shows every changed file as covered, explained, or flagged. Keep the control shot (`"expect": "unchanged"`) on a page the diff should not affect; when the app shell changed, use an element outside the shell, such as the page's `main`, with no `padding` that reaches into the shell.

## 4. Serve both sides

1. **After**: use the current checkout when it is the after ref. Otherwise create a worktree for it as for before.
2. **Before**: `git worktree add --detach <before-dir> <before-ref>`, where `<before-dir>` is a fresh temporary directory outside the repository, such as `$(mktemp -d)/before`. Install dependencies the project's way with a frozen lockfile, and start the same dev command.
3. **Ports**: two free, non-default ports. Pass `--port <n> --strictPort --host 127.0.0.1` to Vite and the equivalent elsewhere, and put the URL each server prints into the manifest. Without `--host`, Vite binds `localhost`, which may resolve to IPv6 only, so a `127.0.0.1` URL can be refused. Set any API base URL or CORS variables an agent-started frontend needs.
4. **Same inputs**: point both sides at the same backend or mocks, data, account, feature flags and environment, so the frontend code is the only variable. When the diff also changes the API, run each side against its own backend only if the project's rules allow it; otherwise say in the report that the before shots run against the new API.
5. **Fidelity**: capture real app routes. Use a story or harness only when no route renders the component, and add `(story)` to the label. Never inject CSS or edit the DOM to imitate a change; the report exists to show what the code does.

Set each side's `dir` in the manifest to its checkout, so the report records the commit and the count of uncommitted files on each side, and warns when both sides are the same code.

## 5. Give the pages realistic data

Use a backend only when the project's rules say it is safe and both sides can share it. Otherwise mock it, which also makes every capture repeatable:

1. Point the frontend's API URL at a closed loopback port, such as `http://127.0.0.1:4399/api`, and set `"allowHosts": []`, `"servicePolicy": "mock-only"` and `"placeholderImages": true`. Nothing then leaves the machine: requests to other hosts, WebSockets included, are blocked and listed, API calls no mock answers are blocked even on the frontend's own origin, and blocked images render as neutral placeholders. These guard the browser only, so start server processes (SSR, dev proxies) against mocks or a disposable stack.
2. Capture once without mocks. The run lists each unanswered fetch, XHR, EventSource and WebSocket call and writes them to `<report-dir>/unanswered.json`.
3. Draft mocks from the project's own types:

   ```bash
   node <skill-dir>/scripts/mocks.mjs draft <report-dir> --project <tsconfig.json or jsconfig.json>
   ```

   For each unanswered endpoint it finds the calling code, reads the response type that code expects (TypeScript or JSDoc), and writes a mock with plausible fictional values. GraphQL calls are matched by operation name and WebSocket mocks get a sample message. Endpoints it cannot type get an empty body and a `TODO` note naming the call sites and fixtures that mention them.
4. Review the draft: flags that hide whole screens (maintenance, feature flags, permissions), enum values that pick a variant, list lengths, and every field the change displays. Then list it in the manifest (`"mocks": ["mocks.draft.json"]`) and recapture.
5. Add per-shot mocks for the states the change shows: `status` for errors, `pending` for loading, empty lists, long strings. `mocks.mjs sample <TypeName> --project <tsconfig>` prints a value of any named type for such variants.

Both sides get the same mocks, so any difference comes from the frontend code. Use fictional data only, never real users' data. Before writing mocks by hand, look for fixtures the project already has (MSW handlers, end-to-end fixtures, HAR files); `mocks.mjs find <url>` lists the files that mention an endpoint. `references/mocking.md` covers matching rules, stateful handlers, Socket.IO, third-party scripts, and `mocks.mjs serve` for frameworks that fetch data on the server, out of reach of in-browser mocks.

## 6. Capture

`references/manifest.md` has every field. A typical manifest:

```json
{
  "title": "feat/report-button vs development",
  "before": { "baseURL": "http://127.0.0.1:5301", "ref": "development 6db915d", "dir": "/tmp/tmp.x1/before" },
  "after": { "baseURL": "http://127.0.0.1:5302", "ref": "working tree", "dir": "/home/me/app" },
  "viewports": ["desktop", "mobile"],
  "fixedTime": "2026-01-15T10:00:00Z",
  "allowHosts": [],
  "servicePolicy": "mock-only",
  "placeholderImages": true,
  "hide": [".app-version"],
  "mocks": ["mocks.draft.json"],
  "changedFiles": ["src/components/footer.tsx", "src/components/report-dialog.tsx"],
  "shots": [
    { "id": "footer", "label": "Home › footer", "path": "/", "selector": "footer", "padding": 16, "expect": "changed", "sources": ["src/components/footer.tsx"] },
    { "id": "report-dialog", "label": "Home › footer › Report a problem, open", "path": "/", "new": true, "steps": [{ "click": "role=button[name=\"Report a problem\"]" }], "selector": "role=dialog", "padding": 16, "sources": ["src/components/report-dialog.tsx"] },
    { "id": "about", "label": "About (control)", "path": "/about", "expect": "unchanged" }
  ]
}
```

```bash
bash <skill-dir>/scripts/setup.sh
node <skill-dir>/scripts/capture.mjs <report-dir>/manifest.json --out <report-dir>
```

`setup.sh` is idempotent, so run it before the first capture of a session. When pages need a login, follow the project's account rules. If the user should log in themselves, run `node <skill-dir>/scripts/capture.mjs login <after-baseURL> <state.json>`: it opens a browser and saves the session when they close the window. Set `storageState` to that file, keep it outside every repository, and delete it when done, because it is a credential.

Make the pairs comparable: the same viewport, theme, locale and timezone on both sides, `fixedTime` for relative dates, `mask` for clocks, avatars and live maps, `hide` for toasts, dev overlays and build-time strings such as versions or commit hashes (a mask keeps the element's size, and those strings differ in length), and `waitForHidden` for spinners. Prefer element shots with `padding` over full pages, so the reader sees the change with enough context to place it.

## 7. Check the report before handing over

Open `index.html` and look at every changed, new and removed image. Work through **Needs attention** until each item is fixed or explained:

| Result | Action |
| --- | --- |
| Expected a change, but identical | Wrong location or state, or missing data hides it. Fix the shot or the mocks. |
| Expected no change, but regions differ | Nondeterminism or a real side effect. Mask or pin the noise and recapture; if it persists, report it as a regression. |
| Unanswered API calls | The screen may lack data. Mock them (step 5) or confirm they do not affect the screen. |
| Errors only on the after side | The change logs a new error or exception. Report it. |
| Changed file with no shot | Add a shot, or a `notCaptured` reason. |
| `failed` | The error names the failing step. Fix the selector or steps; if the state is unreachable, keep the row and give the reason. |
| `added` | Confirm the after image shows the new UI. |

The circled image outlines what is new or modified on the after side, numbered to match the close-ups. Content that only moved, for example pushed down by an inserted element, is not circled; the diff image marks every differing pixel, moved content included. A circled region you cannot explain is either noise to mask or a real side effect worth reporting.

Recapture only the fixed shots with `--only <id>,<id>`; results merge into the existing report. A side that fails is retried once automatically, which absorbs dev-server reloads. Kept results whose manifest, mocks or fixture files changed since they were captured are flagged as stale, and shots without a result as not run. `capture.mjs compare --out <report-dir>` re-diffs the existing PNGs without a browser, and `capture.mjs report --out <report-dir>` only re-renders the HTML and Markdown. Add `--strict` to any of them to exit with status 2 while items need attention, which suits scripted checks.

## 8. Hand over and clean up

1. Give the path to `index.html`, and open it when the user is on this machine (`xdg-open` or `open`).
2. Summarize: the counts, one line per changed location, unexpected results and how each was resolved, every changed file not captured with its reason, whether data was mocked, and the two refs.
3. Attach images to a PR only when the user asks. Run `gh pr edit <n> --body-file <report-dir>/report.md --attach ./shots/<file>.png ...` from inside the report directory, so the attach paths match the Markdown references. This needs gh 2.99 or newer; on an older gh, say so and leave the report local.
4. Stop every server you started, including `mocks.mjs serve`. Remove the before worktree the way the host's rules require (`git worktree remove <before-dir>` by default). Delete the storage state. Keep the report directory.
