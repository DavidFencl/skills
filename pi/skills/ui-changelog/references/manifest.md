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
| `mask` | `[]` | Selectors painted over in every shot: clocks, avatars, random IDs, live maps. |
| `waitForHidden` | `[]` | Selectors that must disappear before capture, such as spinners and skeletons. |
| `settleMs` | `300` | Extra wait after load and after each step. `0` disables. |
| `timeoutMs` | `10000` | Per-locator timeout. Navigation waits at least 30 s. |
| `networkIdleTimeoutMs` | `10000` | Upper bound on waiting for network idle. Apps with polling or websockets never go idle, so this caps the wait. |
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
| `mask`, `viewport`, `colorScheme`, `locale`, `deviceScaleFactor` | Per-shot overrides. |
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

## Result statuses

| Status | Meaning |
| --- | --- |
| `changed` | Both sides captured and pixels differ, or the size changed. A diff image is written. When the size changed, the extra area counts as different, so the percentage overstates the change. |
| `added` | The shot is marked `new` and the after side captured. |
| `removed` | The shot is marked `removed` and the before side captured. |
| `failed` | A side that should have captured did not. The error is in `results.json` and the report. |
| `unchanged` | Identical within `minDiffPixels`. One image is kept in the report. |
