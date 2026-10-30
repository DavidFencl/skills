# Capture manifest

`capture.mjs` reads one JSON manifest. Write it outside the repository under review, next to the report. Relative paths in it (mock files, HAR files, init scripts) resolve from the manifest's directory. Unknown fields are named in a warning before the capture starts, and a manifest that still contains a `TODO` placeholder from `affected.mjs --manifest` is refused.

Contents: top level, sides, shots, steps, result statuses, output files. Mock entries are documented in `mocking.md`.

## Top level

| Field | Default | Meaning |
| --- | --- | --- |
| `title` | `UI changelog` | Report heading. Include the refs, such as `feat/x vs development`. |
| `before`, `after` | required | The two sides (below). |
| `shots` | required | Array of shots, captured in order. Report rows keep this order. |
| `viewport` | `1280×800` | `{ "width", "height" }` in CSS pixels, plus `"mobile": true` to emulate a phone (mobile layout viewport and touch). |
| `viewports` | none | Default viewport list for every shot without its own, such as `["desktop", "mobile"]`. Each shot becomes one pair per viewport. |
| `viewportPresets` | built-ins | Extra or overridden named viewports. Built-ins: `mobile` 390×844 phone, `tablet` 768×1024 with touch, `desktop` 1280×800. |
| `deviceScaleFactor` | `1` | Use `2` only when text crispness is the change. |
| `colorScheme` | `light` | `light` or `dark`. |
| `locale`, `timezoneId` | browser, `UTC` | Pin both so dates and number formats match on both sides. |
| `fixedTime` | none | ISO time. Freezes `Date` so relative timestamps match. `mocks.mjs draft` also dates its values around it. |
| `storageState` | none | Playwright storage state file (from `capture.mjs login`). A state with one origin is re-keyed to each side's origin. |
| `localStorage` | none | `{ "key": value }` written before every page load, such as a dismissed cookie banner or a chosen language. |
| `extraHTTPHeaders` | none | Sent with every request. |
| `allowHosts` | none | When set, requests are blocked unless their host is the side's own host or in this list, WebSockets included. `[]` keeps every request on the frontend's host. Blocked requests are listed in each shot's capture details. |
| `servicePolicy` | none | `"mock-only"` blocks every fetch, XHR, EventSource and WebSocket call that no mock or HAR entry answers, on the frontend's own origin too, where a dev-server proxy would otherwise forward it to a real backend. Dev-server hot-reload sockets stay open. Blocked calls are listed as unanswered. It guards the browser only: configure server processes (SSR, proxies) for a disposable stack or `mocks.mjs serve` before starting them. |
| `placeholderImages` | `false` | With `allowHosts`, answer blocked image requests with a neutral placeholder instead of a broken image. |
| `serviceWorkers` | `block` | `allow` lets the app register service workers. Blocked by default, because a service worker can answer requests itself, out of reach of mocks and `allowHosts`. |
| `mocks` | `[]` | Mock objects, or paths to JSON files that hold arrays of them (`mocking.md`). |
| `har` | none | HAR file replayed for matching requests. Unmatched requests fall through to `allowHosts`. |
| `initScripts` | `[]` | Scripts run before the page's own code, as file paths or `{ "content": "..." }`: stub a third-party SDK global or seed storage. Both sides get them, and the report lists them. Never use one to imitate the change. |
| `contextOptions` | none | Extra Playwright browser-context options, such as `geolocation`, `permissions` or `userAgent`. |
| `mask` | `[]` | Selectors painted over in every shot: clocks, avatars, random IDs, live maps. The mask keeps the element's size. |
| `hide` | `[]` | Selectors hidden with screenshot-only CSS (`visibility: hidden`), such as toasts, dev overlays and build-time version strings. Never use it to hide or fake the change itself. |
| `waitForHidden` | `[]` | Selectors that must disappear before capture, such as spinners and skeletons. |
| `settleMs` | `300` | Extra wait after load and after each step. `0` disables. |
| `timeoutMs` | `10000` | Per-locator timeout. Navigation waits at least 30 s. |
| `networkIdleTimeoutMs` | `10000` | Upper bound on waiting for a quiet network (500 ms with nothing in flight). Requests a mock holds open with `pending`, EventSource streams and WebSockets do not count; apps that poll never go quiet, so this caps the wait. |
| `minDiffPixels` | `0` | Pairs with this many differing pixels or fewer count as unchanged. Raise it only after confirming the noise is benign. |
| `changedFiles` | none | The changed UI files (from `affected.mjs --manifest`). The report lists each with the shots whose `sources` include it, and flags files with neither a shot nor a `notCaptured` reason. |
| `notCaptured` | none | `[{ "file": "src/types.ts", "reason": "types only" }]`, or `{ "location", "reason" }` for a place that could not be captured. Shown in the report. |

## Sides

`before` and `after` each take:

| Field | Meaning |
| --- | --- |
| `baseURL` | Required. The side's dev server, such as `http://127.0.0.1:5301`. |
| `ref` | Display label, such as `development 6db915d` or `working tree`. |
| `dir` | The side's checkout. The report records its commit and the number of uncommitted files, and warns when both sides are the same code. |
| `storageState` | Overrides the top-level `storageState` for this side. |

## Shot

| Field | Meaning |
| --- | --- |
| `id` | Unique, stable. File names derive from it, and `--only` selects by it. |
| `label` | Breadcrumb plus state, such as `Event › Results tab, empty`. |
| `path` | URL path and query, resolved against each side's `baseURL`. |
| `viewports` | Names or `{ "name", "width", "height", "mobile" }` objects. The shot expands into `<id>-<name>` shots; `--only <id>` selects all of them. Ignored when the shot sets `viewport`. |
| `selector` | Capture only this element (the first match). Omit for the viewport. |
| `padding` | CSS pixels of context around `selector`. Use 8 to 24 so the reader sees where it sits. |
| `fullPage` | Capture the whole scrollable page instead of the viewport. |
| `new` | The UI does not exist on the base. The before side is skipped, and the shot is reported as `added`. |
| `removed` | The change deletes this UI. The after side is skipped, and the shot is reported as `removed`. |
| `expect` | `changed` or `unchanged`, or per viewport: `{ "mobile": "changed", "desktop": "unchanged" }`. A result that contradicts it is listed under Needs attention. |
| `steps` | Actions run after load, in order (below). |
| `waitFor` | Selector that must be visible before capture. |
| `mocks`, `initScripts`, `hide` | Added to the top-level lists for this shot. A shot's mocks win over top-level ones. |
| `mask`, `viewport`, `colorScheme`, `locale`, `deviceScaleFactor`, `har`, `networkIdleTimeoutMs`, `contextOptions` | Per-shot overrides. |
| `threshold` | pixelmatch color threshold, default `0.1`. |
| `sources` | Changed files this shot covers, as repo-relative paths matching `changedFiles`. |
| `note` | One line shown under the label. |

## Steps

Each step is an object with one action key. Selectors are Playwright selectors (`css`, `text=…`, `role=button[name="Save"]`, `[data-testid=x]`, `#id:has-text('Saved')`). The first match is used. A failing step is reported with its number and JSON.

| Step | Effect |
| --- | --- |
| `{ "click": sel }` | Click. |
| `{ "hover": sel }` | Hover, for tooltips and hover styles. |
| `{ "focus": sel }` | Focus, for focus rings. |
| `{ "fill": sel, "value": "text" }` | Type into an input. |
| `{ "select": sel, "value": "option" }` | Choose a `<select>` option. |
| `{ "check": sel }` | Tick a checkbox or radio. |
| `{ "press": "Escape", "selector": sel? }` | Press a key, on an element or the page. |
| `{ "scroll": sel }` | Scroll an element into view. |
| `{ "waitFor": sel }`, `{ "waitForHidden": sel }` | Wait for visibility or disappearance. |
| `{ "goto": "/other" }` | Navigate within the same side. |
| `{ "wait": 500 }` | Fixed wait in ms. Prefer `waitFor`. |

Steps must not persist anything. Opening a dialog and typing into a field is fine. Submitting a form that writes is not, unless the stack is disposable or the endpoint is mocked.

## Result statuses

| Status | Meaning |
| --- | --- |
| `changed` | Both sides captured and pixels differ, or the size changed. A diff image and a circled image are written, and `regions` lists the circled boxes in reading order, each with `n` (its number on the image) and `before` (the matching box on the before image, or `null` for content that was only inserted). When the size changed, the extra area counts as different, so the percentage overstates the change. |
| `added` | The shot is marked `new` and the after side captured. |
| `removed` | The shot is marked `removed` and the before side captured. |
| `failed` | A side that should have captured did not. The error is in `results.json` and the report. |
| `unchanged` | Identical within `minDiffPixels`. Listed by name only in the report. |
| `not-run` | The shot is in the manifest but has no result yet, for example after `--only`. Listed under Needs attention. |

A kept result whose shot, shared settings or named files (mocks, HAR, init scripts, storage state) changed after it was captured is marked `stale` and listed under Needs attention.

## Output files

| File | Contents |
| --- | --- |
| `index.html`, `report.md` | The report. `capture.mjs report --out <dir>` re-renders both from `results.json`. |
| `results.json` | Every shot with its status, regions, and per side: `file`, `url`, size, `network` (`mocked` hits, `unanswered` calls, `blocked` requests, data mocks that `skipped` non-API requests), `errors` (console errors and uncaught exceptions), `warnings`, and `retried` when the first attempt failed. |
| `unanswered.json` | One entry per endpoint that got no answer: method, origin (empty for the frontend's own origin), path, reasons, example URLs, request body, and the shots that called it. Input for `mocks.mjs draft`. |
| `manifest.json` | A copy of the manifest used. |
| `shots/` | `<id>-before.png`, `<id>-after.png`, `<id>-diff.png`, `<id>-circled.png`. Set `UI_CHANGELOG_DEBUG=1` to also write the change mask. |
