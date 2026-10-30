# Troubleshooting

Symptoms seen in real runs, what causes them, and the fix. Recapture fixed shots with `--only <id>`.

## Capture fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `server http://127.0.0.1:… is unreachable` | The dev server bound `localhost`, which resolves to IPv6 only, or it is not running. | Start it with `--host 127.0.0.1` (Vite) or the equivalent, and use the URL it prints. |
| A shot fails once, then captures on the retry | The dev server reloaded the page, for example Vite optimising dependencies on the first visit. | Nothing; one retry is automatic and recorded under the side's `retried`. If it fails twice, load the page once by hand first. |
| `step 3 {"click": …}: Timeout` | The selector matches nothing in that state, or matches a hidden element first. | Open the after side in a browser and check the selector. Prefer `role=` and `data-testid` selectors, and add a `waitFor` step before the action. |
| One side fails on a shot that is not `new` or `removed` | The UI only exists on one side, or the before side lacks a route the shot needs. | Mark it `new` or `removed` if that is the truth; otherwise fix the shot. A broken selector is never reported as new UI. |
| `The manifest still has TODO placeholders` | The skeleton from `affected.mjs --manifest` was not filled in. | Replace each listed value. |
| `Missing dependency "playwright"` | The tool cache is not installed. | Run `bash <skill-dir>/scripts/setup.sh`. |
| The browser cannot start (missing libraries, sandbox errors) | The machine or sandbox lacks Chromium's system libraries, or blocks it. | Run `npx playwright install-deps chromium` with the owner's approval, or run the capture where a browser can start. Say which part could not run. |

## Pages render wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Skeletons, spinners or "could not be reached" toasts | API calls went unanswered. | Mock them (`mocking.md`); the run lists them and writes `unanswered.json`. |
| A mock never matches | The URL carries a query string, a different origin or a trailing slash. | Globs ignore queries unless they contain `?`. Compare the glob with the unanswered URL; use `query` for variants. |
| The app breaks as soon as mocks are added | A broad glob such as `**/api/**` caught non-API requests. | Data mocks skip scripts, styles and documents and the report names the mock, but pin the URL to the API origin anyway. |
| Mocks are ignored after the first load | A service worker answers requests itself. | Leave `serviceWorkers` at its default, `block`. |
| A third-party widget is blank or throws | `allowHosts` blocked its script. | Stub it with an `initScripts` entry or a script mock, or allow the host when it is safe and read-only. |
| A phone viewport shows the desktop layout | The page has no `<meta name="viewport" content="width=device-width">`, so a phone lays it out at 980 px and mobile styles never apply. | The warning names the shot. Real phones render it the same way, so keep the shot and report the missing tag; mobile-only changes cannot show until it exists. |
| Relative dates or clocks differ between the sides | The capture time differs. | Set `fixedTime`, and `mask` live clocks. |

## Noisy or misleading pairs

| Symptom | Cause | Fix |
| --- | --- | --- |
| A control shot, or an area the diff cannot reach, is circled | Nondeterministic content: build version, commit hash, random IDs, ads, avatars, live data. | `hide` strings whose length differs (a version or hash; a mask keeps the element's size, so the mask itself moves), `mask` the rest, and recapture. If it persists, it is a real side effect: report it. |
| Everything below an insertion lights up in the diff | Pixel diffs mark moved content. | Read the circled image and the close-ups instead; they align rows first, so only new or modified content is circled. |
| A huge percentage on a small change | The element's size changed, and the added area counts as different. | Trust the regions and close-ups, not the percentage. |
| Text renders slightly differently between runs | Font loading or subpixel antialiasing. | Use the same `deviceScaleFactor` on both sides; the capture waits for fonts. Raise `threshold` slightly, or `minDiffPixels` only after checking the noise is benign. |
| An expected change shows as unchanged | The shot shows the wrong place or state, or missing data hides it. | Check the path, steps and mocks; the report flags this when the shot has `"expect": "changed"`. |
| Close-up of a change shows an unrelated before area | Columns that shift by different amounts were aligned as one block. | Read the full before and after images for that region; close-ups are a guide. |

## Hand-over problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| `gh pr edit --attach` is unknown | gh is older than 2.99. | Say so and keep the report local, or paste images through the web UI. |
| The report says both sides are the same commit | `before.dir` and `after.dir` point at the same checkout, or the worktree was created at the wrong ref. | Recreate the before worktree at the before ref. |
