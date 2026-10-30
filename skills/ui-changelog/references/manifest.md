# Capture manifest

`capture.mjs` reads one JSON manifest. Write it outside the repository under review, next to the report.

## Top level

| Field | Default | Meaning |
| --- | --- | --- |
| `title` | `UI changelog` | Report heading. Include the refs, such as `feat/x vs development`. |
| `before`, `after` | required | `{ "baseURL": "http://127.0.0.1:5301", "ref": "abc1234", "storageState": "/abs/state.json" }`. `ref` is a display label. `storageState` overrides the top-level one for that side. |
| `shots` | required | Array of shots, captured in order. Report rows keep this order. |
| `viewport` | `1280×800` | `{ "width", "height" }` in CSS pixels. |
| `deviceScaleFactor` | `1` | Use `2` only when text crispness is the change. |
| `colorScheme` | `light` | `light` or `dark`. |
| `locale`, `timezoneId` | browser, `UTC` | Pin both so dates and number formats match on both sides. |
| `fixedTime` | none | ISO time. Freezes `Date` so relative timestamps match. |
| `storageState` | none | Playwright storage state file (from `capture.mjs login`). A state with one origin is re-keyed to each side's origin. |
| `localStorage` | none | `{ "key": value }` written before every page load, such as a dismissed cookie banner or a chosen language. |
| `extraHTTPHeaders` | none | Sent with every request. |
| `allowHosts` | none | When set, requests are aborted unless their host is the side's own host or in this list. `[]` keeps every request on the frontend's host. Use it when the app could otherwise reach production APIs, analytics or error reporting. |
| `mask` | `[]` | Selectors painted over in every shot: clocks, avatars, random IDs, live maps. |
| `hide` | `[]` | Selectors hidden with screenshot-only CSS (`visibility: hidden`), such as toasts and dev overlays that may or may not appear. Never use it to hide or fake the change itself. |
| `waitForHidden` | `[]` | Selectors that must disappear before capture, such as spinners and skeletons. |
| `settleMs` | `300` | Extra wait after load and after each step. `0` disables. |
| `timeoutMs` | `10000` | Per-locator timeout. Navigation waits at least 30 s. |
| `networkIdleTimeoutMs` | `10000` | Upper bound on waiting for network idle. Apps with polling or websockets never go idle, so this caps the wait. |
| `mocks` | `[]` | API responses answered inside the browser (below). |
| `har` | none | HAR file replayed for matching requests. Unmatched requests fall through to `mocks` and `allowHosts`. |
| `minDiffPixels` | `0` | Pairs with this many differing pixels or fewer count as unchanged. Raise it only after confirming the noise is benign. |

## Shot

| Field | Meaning |
| --- | --- |
| `id` | Unique, stable. File names derive from it, and `--only` selects by it. |
| `label` | Breadcrumb plus state, such as `Event › Results tab, empty`. |
| `path` | URL path and query, resolved against each side's `baseURL`. |
| `selector` | Capture only this element. Omit for the viewport. |
| `padding` | CSS pixels of context around `selector`. Use 8 to 24 so the reader sees where it sits. |
| `fullPage` | Capture the whole scrollable page instead of the viewport. |
| `new` | The UI does not exist on the base. The before side is skipped, and the shot is reported as `added`. |
| `removed` | The change deletes this UI. The after side is skipped, and the shot is reported as `removed`. |
| `steps` | Actions run after load, in order (below). |
| `waitFor` | Selector that must be visible before capture. |
| `mask`, `viewport`, `colorScheme`, `locale`, `deviceScaleFactor`, `har`, `networkIdleTimeoutMs` | Per-shot overrides. `hide` and `mocks` add to the top-level lists, and a shot's mocks win over top-level ones. Lower `networkIdleTimeoutMs` on shots that capture a `pending` request. |
| `threshold` | pixelmatch color threshold, default `0.1`. |
| `sources` | Changed files this shot covers. Shown in the report. |
| `note` | One line shown under the label, such as `control: expected unchanged`. |

## Steps

Each step is an object with one action key. Selectors are Playwright selectors (`css`, `text=…`, `role=button[name="Save"]`, `[data-testid=x]`). The first match is used.

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

Steps must not persist anything. Opening a dialog and typing into a field is fine. Submitting a form that writes is not, unless the stack is disposable.

## Mocks

Each mock answers requests whose URL matches `url`, a glob where `*` stays within one path segment and `**` crosses segments. The query string is ignored unless the glob contains `?`. Use `urlRegex` to match the full URL instead. Mocks get CORS headers and answer preflight requests, so an API on another origin works. When several mocks match, the one listed last wins.

| Field | Meaning |
| --- | --- |
| `url` or `urlRegex` | What to answer. Pin it to the API origin. |
| `method` | `"POST"` or a list. Omit to answer every method. |
| `json` | Response body, serialized as JSON. |
| `file` | Response body read from a file relative to the manifest. `.json` files get a JSON content type. |
| `body`, `contentType`, `headers` | Raw body and headers. |
| `status` | HTTP status, default `200`. Use 4xx and 5xx for error states. |
| `delayMs` | Wait before answering. |
| `pending` | Never answer, to capture a loading or sending state. |
| `abort` | Fail the request as a network error, such as `"connectionrefused"` or `"timedout"`. |
| `times` | Answer only the first N matching requests, then fall through. |

```json
"mocks": [
  { "url": "http://127.0.0.1:4399/api/event/upcoming-events", "file": "mocks/upcoming-events.json" },
  { "url": "http://127.0.0.1:4399/api/support-report", "method": "POST", "json": { "reportId": "SR-2026-0042" } }
]
```

The capture prints `unanswered API calls` per shot: fetch and XHR requests that failed or returned 5xx without a mock. Mock those, or confirm they do not affect the screen.

## Result statuses

| Status | Meaning |
| --- | --- |
| `changed` | Both sides captured and pixels differ, or the size changed. A diff image and a circled image are written, and `regions` lists the circled boxes. When the size changed, the extra area counts as different, so the percentage overstates the change. |
| `added` | The shot is marked `new` and the after side captured. |
| `removed` | The shot is marked `removed` and the before side captured. |
| `failed` | A side that should have captured did not. The error is in `results.json` and the report. |
| `unchanged` | Identical within `minDiffPixels`. Listed by name only in the report. |
