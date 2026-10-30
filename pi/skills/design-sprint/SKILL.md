---
name: design-sprint
description: "Run a focused UI design sprint. Build 2–4 distinct variants of a screen or component, plus single-property decision options, from the project's own design system. Serve a local decisions page where the user picks a variant, keeps the current version, or re-prompts a change, and iterate until they submit an answer. Use for 'design sprint', 'show me options', 'mock up variants', or any UI choice that is a matter of taste."
allowed-tools: read write edit bash grep find ls
---

# Design sprint

Settle UI taste questions by showing the user the options rendered, not by describing them. The user answers by clicking. You iterate on their re-prompts until they submit.

`<skill-dir>` below means the directory that contains this file.

## Input

- `/skill:design-sprint <screen or component> [what to explore]`, for example `/skill:design-sprint organizer applications list: density and grouping`.
- Without arguments, ask which screen or component to explore and stop.

A sprint explores and decides. It does not change production code. Implementing the winner is a separate task.

## 1. Frame

1. Read the project's design contract and building blocks:
   - design docs (`DESIGN.md`, a design-system README)
   - theme and token files
   - the shared component directory
   - lint rules for styling
   - the stack (framework, styling, i18n)
   - the target's current implementation and the data it shows
2. Write a five-line brief for yourself:
   - who uses the screen
   - their one task
   - the facts it must show
   - the primary action
   - constraints such as themes, locales, devices and accessibility
3. Ask at most three questions, and only if the target or its users are unclear. Otherwise proceed.
4. Split the open questions into two kinds:
   - **Variants:** 2–4 structurally different answers for the whole screen or component, for example flat rows, grouped sections, or list plus detail. Each one is a complete, convincing answer, never a strawman. Recommend at most one.
   - **Decisions:** questions where exactly one property changes, such as accent use, corner radius, density, heading style or button width. Each option differs from the others only in that property.
5. Every variant set and every decision always includes **Do nothing (keep current)**. The page adds it automatically. Give it an honest preview of today's real screen through `current`.

## 2. Build

Build the previews as development-only artifacts that never ship:

| Stack | Where previews live |
|---|---|
| Vite | An extra root HTML entry (Vite serves it in dev and builds only `index.html`), loaded through `if (import.meta.env.DEV) await import(...)` |
| Next.js | A route under a dev-only segment that calls `notFound()` when `process.env.NODE_ENV === 'production'` |
| Storybook present | Stories under a `Design sprint/` title |
| Anything else | Static HTML files inside `.design-sprint/<slug>/`, served by `serve.mjs` at `/files/...` |

Rules:
- **Use the real shared components, tokens and helpers**, with their existing props. Do not edit shared components, tokens or global styles during a sprint. Express a decision option as a local override scoped to its preview, such as a data attribute with CSS custom-property overrides.
- **Use realistic fixtures:** long and localized names, mixed states, and an empty state. Make no API requests and no writes. Never touch production data.
- **One preview page per variant or option,** selected by query, for example `?variant=a&theme={theme}`. Support every theme in `themes`.
- **Meet the project's lint and type checks** on the new files, with no baseline or allow-list additions.
- **Delegate when you can:** if your harness can run parallel subagents, give each variant to its own subagent with the same brief, so the directions really differ. Review each result yourself.
- **Prove the previews stay out of production:** run the production build and check that the preview pages and modules are absent.

## 3. Serve

1. Write `.design-sprint/<slug>/sprint.json` following `<skill-dir>/references/manifest.md`; `<skill-dir>/assets/example-sprint.json` is a complete example. Exclude `.design-sprint/` from git, preferably through `.git/info/exclude` so no tracked file changes.
2. Capture today's screen for `current`, either as a URL or as a screenshot saved in the sprint directory.
3. Start the project's dev server on a non-default port. Do not take over a server the user is already running.
4. Run `node <skill-dir>/scripts/serve.mjs --sprint .design-sprint/<slug> --port 4390` as a background process.
5. Open the page for the user: `xdg-open http://127.0.0.1:4390/` on Linux, `open` on macOS. Also give them the URL.
6. Tell them:
   - **pick:** pick a direction and one option per decision, where "Do nothing" counts as a pick;
   - **change:** use "Change variant", "None of these" and "None of these fit" to ask for changes;
   - **submit:** press Submit answer when done.

## 4. Iterate

Loop until a `submit` event arrives:

1. Wait for feedback with `node <skill-dir>/scripts/wait.mjs --sprint .design-sprint/<slug> --after <count>`. Run it in the background if your harness caps foreground commands. It prints `{ count, events }`. Pass the printed `count` as `--after` next time.
2. Handle each event (types are in `references/manifest.md`):
   - **`pick`:** note it. No action is needed.
   - **`reprompt`:**
     1. Add `{ "feedbackId": <id>, "status": "working" }` to `requests` immediately, so the user sees that it was received.
     2. Build what the text asks for:
        - `variant:<id>` produces a new variant derived from that one. Give it the next free letter, `basedOn` set to the source variant and `prompt` set to the user's text.
        - `direction` produces a new direction.
        - `decision:<id>` produces a new option for that decision.
        - `sprint` is a general change.
     3. Keep the earlier variants unless the user asked to replace one; then set `retired: true` on it.
     4. Increment `round` and set the request to `done` with a one-line note.
     5. If the request is ambiguous, set it to `declined` with your question in `note`, and ask the same question in chat.
   - **`submit`:** stop the loop.
3. Batch the re-prompts that arrive together into one round. Verify every new preview renders in every theme and width before marking its request `done`.

## 5. Close

1. Report the answer line. Next to each pick, give its consequence in one sentence.
2. Record the decisions where the project keeps design rules, for example DESIGN.md. Record "keep" picks too: they are decisions.
3. Offer to implement the winning variant as a normal task with the project's usual tests and review. Do not implement it inside the sprint.
4. Stop the servers you started.
5. Ask whether to keep the preview files. If not, delete them along with `.design-sprint/<slug>/`. Keep `feedback.jsonl` if the user wants the trail.

## Rules

- **Honest previews:** label approximations on the preview itself. "Do nothing" must show what exists today, not a weakened copy.
- **A fair comparison:** every variant gets the same fixtures, themes and widths, and the same care.
- **Safety:** bind servers to 127.0.0.1. Never load production data into previews, and never ship preview code.
