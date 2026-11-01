# sprint.json, feedback.jsonl and the page

The sprint page renders `.design-sprint/<slug>/sprint.json` and polls the server every second, so your edits appear without a reload. `assets/example-sprint.json` is a complete example.

## What the user sees

The page walks the user through the sprint one step at a time. It derives its phase from the files, so you never set the phase yourself:

| Phase | When | The page shows |
|---|---|---|
| building | `variants` is empty and nothing is submitted | The goal, `current`, and your progress: lane progress while `lanes.mjs` runs, otherwise `status`. |
| choosing | variants exist and nothing is submitted | One step at a time: Direction, then one step per decision, then Review. |
| wrap-up | a `submit` event exists and `done` is absent | The submitted answer, whether you received it, what you are doing, and any open questions. |
| done | `done` is set | `done.message`, the answer and, for a blind sprint, the models. The page stops polling, and `serve.mjs` exits. |

A header on every phase shows your presence, derived by the server:
- **Listening:** `wait.mjs` is running. Whatever the user sends reaches you at once.
- **Working:** you are not listening. The page shows `status.message`, or the running lanes.
- **No activity:** nothing has changed for 10 minutes. The page tells the user to check the terminal.

Under the presence line, the header points at the one thing that most needs the user: an open question first, then running work, then the latest request. Its Reply or Show button jumps to it, on whichever step it is.

Every re-prompt shows as a thread on the step it targets: the user's text, `Sent` until `wait.mjs` has handed it to you, then your `status` and `note`, then your questions about it with the user's answers. Requests about a retired variant or a replaced decision move to Earlier requests on the Review step.

## sprint.json

| Field | Type | Meaning |
|---|---|---|
| `title` | string | Sprint name. |
| `goal` | string | One sentence: whose task the screen serves and what the sprint decides. |
| `mode` | `"redesign"` or `"new-feature"` | Default `"redesign"`. In `"new-feature"` mode, Do nothing on the direction step reads "Don't add it", and after the user picks a variant the page waits for you to add decisions. |
| `round` | number | Current round. Increment it each time you answer a batch of re-prompts. |
| `viewports` | number[] | Preview widths. Default `[390, 1280]`. |
| `themes` | string[] | Optional theme names. The page offers a theme switch and substitutes `{theme}` in preview URLs. |
| `blind` | boolean | Hide which model made each variant until the user submits, so brand does not bias the pick. Default `false`; set it from the roster's `blind` setting. |
| `status` | `{ "message" }` | What you are doing right now, in the user's terms, such as `Building decision options over B`. Shown while you are not listening. Replace it whenever you start something that takes more than a few seconds. |
| `dropouts` | object[] | Lanes that failed: `{ "id", "model", "reason" }`. Report them; never fill a dropout's slot with another model silently. |
| `current` | preview | Today's screen. Shown on the direction's Do nothing card. For a new feature, the host screen without the feature, or absent when the feature is a new screen. |
| `variants` | variant[] | Competing directions for the whole screen or component. |
| `decisions` | decision[] | Single-property choices. Every option changes one thing. |
| `requests` | request[] | Your status for each re-prompt, keyed by feedback id. |
| `questions` | question[] | Questions you ask the user. Never ask them in chat while the page is open. |
| `done` | `{ "message" }` | Set once the sprint is over: what you did with the answer and what happens next, such as `Recorded 3 decisions in DESIGN.md. Implementing B now in the terminal.` |

Every id (variant, decision, option and question) uses only letters, digits, `.`, `_` and `-`. The server rejects any other id the page sends back.

**preview**: `{ "url": "...", "image": "...", "note": "...", "height": 560 }`. `note` is shown under the preview. Give one of:
- `url`, rendered in a scaled, sandboxed iframe, with `{theme}` and `{width}` substituted;
- `image`.

Either one takes an absolute http(s) URL, such as the project's dev server, or a path without a scheme. A path names a file in the sprint directory and is loaded from the separate preview origin that `serve.mjs` runs. Other schemes, such as `javascript:` or `data:`, are refused.

**variant**: a preview plus `id` (`"A"`, `"B"`, ...), `label`, `intent`, `tradeoffs`, and optionally:
- `round`: the round that produced it. The page marks variants from the latest round after the first as new.
- `basedOn`: the variant it was derived from
- `prompt`: the user's re-prompt text, shown on the card
- `angle`: the angle this lane was given when its model built several variants, shown on the card
- `recommended: true` on at most one variant
- `retired: true` hides a variant the user asked to replace
- `model`: the descriptor of the model that built it, e.g. `codex:gpt-6.1-sol@high`, or `self` when you built it yourself
- `noDecisions: true` in new-feature mode when there is nothing to decide over this variant, so the user can submit it without decision steps
- `reviews`: second opinions, as a list of `{ "model": "<descriptor>", "text": "<two or three sentences>" }` from models other than the author

**decision**: `id` (`"1"`, `"2"`, ...), `question`, `why`, `recommendation` (an option id), `current` (a preview of today's behaviour, or for a new feature the picked variant unchanged) and `options`. In new-feature mode also `basedOn`, the variant the decision changes one property of. The page shows only the decisions built over the picked direction, and waits until there is one. Never reuse the id of a retired variant or a replaced decision, because feedback and requests refer to them.

**option**: a preview plus `id` (`"1a"`, `"1b"`, ...), `label` and `recommended`.

**request**: `{ "feedbackId": "<id from feedback.jsonl>", "status": "working" | "done" | "declined", "note": "..." }`. Your reply to one re-prompt, shown in its thread.
- `working`: `note` says what is happening, such as `Rebuilding B with sticky headers. This takes a few minutes.` In a blind sprint, never name a model in a note, `status` or question before the submit.
- `done`: `note` says what changed and where to look, such as `Added E, based on B.` The header shows it until something newer needs the user.
- `declined`: you will not do it. `note` says why. To ask for clarification instead, add a question with `about`.

**question**: `{ "id": "q1", "text": "...", "options": [ { "id": "yes", "label": "...", "recommended": true } ], "allowText": true, "about": "<feedback id>", "withSubmit": true }`.
- Give `options`, `allowText: true`, or both. Without `options`, the user answers in text.
- `about` ties the question to a request. The page shows it in that request's thread, or above the current step when that thread is on another step.
- `withSubmit: true` puts the question on the Review step, where the user answers it together with the final answer. Use it for what you will do after the sprint, such as implementing the winner or keeping the preview files. The page preselects the `recommended` option.
- Without `withSubmit` or `about`, the page shows the question at once, above whatever step the user is on. With options and no `allowText`, one click answers it.

A question is answered by an `answer` event, or, with `withSubmit`, by the submit's `answers`. Never reuse a question id.

**Do nothing** is always available. The page adds a Do nothing option to the variants and to every decision, using `current` as its preview. To customize it, include your own option with `"keep": true`; the page then uses that option instead of adding one. A new-feature sprint uses this for `As in <variant id>` decision options. A keep pick appears in the answer as `Direction: keep current` or `<decision id>: keep`.

## feedback.jsonl

`scripts/serve.mjs` appends one JSON object per line. `scripts/wait.mjs` prints new events.

| `type` | Fields | Meaning |
|---|---|---|
| `pick` | `target` (`direction` or `decision:<id>`), `option` (variant id, option id, `keep` or `<id>-keep`) | The user's choice for a step, sent when they leave the step. The latest pick per target wins. |
| `reprompt` | `target` (`variant:<id>`, `direction`, `decision:<id>` or `sprint`), `text` | A requested change: to one variant, a new direction ("none of these"), a new option for a decision, or a general request. |
| `answer` | `target` (`question:<id>`), `option` (an option id), `text` | The user's answer to a question without `withSubmit`. At least one of `option` and `text` is present. |
| `submit` | `text` (the answer line, e.g. `Direction B, 1a, 2: keep`), `option` (the user's note, if any), `answers` (`{ "<question id>": { "option", "text" } }`, one entry per `withSubmit` question) | The final answer, with the wrap-up answers inside it, so you get all of them or none. |

Every event also carries `id` and `at` (ISO time). Reference the `id` in `requests[].feedbackId` and `questions[].about`.

`wait.mjs` returns when an event arrives that needs you: anything except a decision pick. Decision picks arrive with the next batch. It records in `listener.json` how many events it has handed you, so the same command never repeats or skips one.

## Presence files

The scripts write these; you never edit them.
- `listener.json`, written by `wait.mjs`: `{ "listening", "seen", "at" }`. `seen` counts the events handed to you so far. While it waits, `wait.mjs` refreshes `at` every 5 seconds.
- `.sprint-id`, written by `serve.mjs`: keys the user's saved picks to this sprint directory, so a new sprint never inherits them.
- `lanes/progress.json`, written by `lanes.mjs run`: `{ "running": ["D"], "finished": [ { "id", "status" } ], "at" }`, refreshed every 5 seconds while lanes run.
