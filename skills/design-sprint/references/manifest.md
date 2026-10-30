# sprint.json and feedback.jsonl

The decisions page renders `.design-sprint/<slug>/sprint.json` and polls it every 2 seconds, so edits appear without a reload. `assets/example-sprint.json` is a complete example.

## sprint.json

| Field | Type | Meaning |
|---|---|---|
| `title` | string | Sprint name. Also keys the user's saved picks, so keep it stable for the whole sprint. |
| `goal` | string | One sentence: whose task the screen serves and what the sprint decides. |
| `round` | number | Current round. Increment it each time you answer a batch of re-prompts. |
| `viewports` | number[] | Preview widths. Default `[390, 1280]`. |
| `themes` | string[] | Optional theme names. The page offers a theme switch and substitutes `{theme}` in preview URLs. |
| `blind` | boolean | Hide which model made each variant until the user submits, so brand does not bias the pick. Default `false`; set it from the roster's `blind` setting. |
| `dropouts` | object[] | Lanes that failed: `{ "id", "model", "reason" }`. Report them; never fill a dropout's slot with another model silently. |
| `current` | preview | Today's screen. Shown on the direction's "Do nothing" card. For a new feature, the host screen without the feature, or absent when the feature is a new screen. |
| `variants` | variant[] | Competing directions for the whole screen or component. |
| `decisions` | decision[] | Single-property choices. Every option changes one thing. |
| `requests` | request[] | Your status for each re-prompt, keyed by feedback id. |

**preview**: `{ "url": "...", "image": "...", "note": "...", "height": 560 }`. `note` is shown under the preview. Give one of:
- `url`, rendered in a scaled, sandboxed iframe, with `{theme}` and `{width}` substituted;
- `image`.

Either one takes an absolute http(s) URL, such as the project's dev server, or a path without a scheme. A path names a file in the sprint directory and is loaded from the separate preview origin that `serve.mjs` runs. Other schemes, such as `javascript:` or `data:`, are refused.

**variant**: a preview plus `id` (`"A"`, `"B"`, ...), `label`, `intent`, `tradeoffs`, and optionally:
- `round`: the round that produced it
- `basedOn`: the variant it was derived from
- `prompt`: the user's re-prompt text, shown on the card
- `angle`: the angle this lane was given when its model built several variants, shown on the card
- `recommended: true` on at most one variant
- `retired: true` hides a variant the user asked to replace
- `model`: the descriptor of the model that built it, e.g. `codex:gpt-6.1-sol@high`, or `self` when you built it yourself
- `reviews`: second opinions, as a list of `{ "model": "<descriptor>", "text": "<two or three sentences>" }` from models other than the author

**decision**: `id` (`"1"`, `"2"`, ...), `question`, `why`, `recommendation` (an option id), `current` (a preview of today's behaviour, or for a new feature the picked variant unchanged) and `options`.

**option**: a preview plus `id` (`"1a"`, `"1b"`, ...), `label` and `recommended`.

**request**: `{ "feedbackId": "<id from feedback.jsonl>", "status": "working" | "done" | "declined", "note": "what you did, or the question you need answered" }`.

**Do nothing** is always available. The page adds a "Do nothing (keep current)" option to the variants and to every decision, using `current` as its preview. To customize it, include your own option with `"keep": true`; the page then uses that option instead of adding one. A new-feature sprint uses this for a `Don't add it` variant and for `As in <variant id>` decision options. A keep pick appears in the answer as `Direction: keep current` or `<decision id>: keep`.

## feedback.jsonl

`scripts/serve.mjs` appends one JSON object per line. `scripts/wait.mjs` prints new events.

| `type` | Fields | Meaning |
|---|---|---|
| `pick` | `target` (`direction` or `decision:<id>`), `option` (variant id, option id, `keep` or `<id>-keep`) | The user's current choice. The latest pick per target wins. |
| `reprompt` | `target` (`variant:<id>`, `direction`, `decision:<id>` or `sprint`), `text` | A requested change: to one variant, a new direction ("none of these"), a new option for a decision, or a general request. |
| `submit` | `text` (the answer line, e.g. `Direction B, 1a, 2: keep`), `option` (the user's note, if any) | The final answer. End the loop. |

Every event also carries `id` and `at` (ISO time). Reference the `id` in `requests[].feedbackId`.
