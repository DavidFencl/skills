---
name: design-sprint
description: "Run a focused UI design sprint, for an existing screen or component or for a new feature that does not exist yet. Several models build N variants from the project's design system, and you add single-property decision options. A local page walks the user through the choices one step at a time, shows what the agent is doing, and carries every follow-up question, so the user never has to return to the terminal mid-sprint. They pick a variant, keep the current version (or not add the feature), or re-prompt a change, and you iterate until they submit. Works in Claude Code, Codex, pi and Grok. Use for 'design sprint', 'show me options', 'mock up variants', 'give me N versions of this feature', or any UI choice that is a matter of taste."
---

# Design sprint

Settle UI taste questions by showing the user rendered options, not by describing them. Like an arena, different models answer the same brief, so the user sees genuinely different opinions. The user answers on a local page, one step at a time. You iterate on their re-prompts until they submit.

`<skill-dir>` below means the directory that contains this file. All scripts need only Node.

## The page is the conversation

Once the page is open, the user is looking at it, not at this chat. Keep the whole sprint there:

- **Ask on the page.** Put every question in `questions` in `sprint.json` (format in `references/manifest.md`). Never ask in chat while the page is open: the user will not see it, and a question in chat ends your wait loop.
- **Listen whenever you are not working.** Keep `wait.mjs` running between rounds. The page shows "Listening" only while it runs, and marks each of the user's events as received when it hands them to you.
- **Say what you are doing.** Before anything that takes more than a few seconds, set `status.message` in `sprint.json`, in the user's terms: `Building decision options over B`, not `running lanes.mjs`.
- **Answer where they asked.** Every re-prompt gets a `requests` entry with a `note` at once, and a final `note` that names what changed.
- **Keep the chat short.** At most one line per round in chat, pointing at the page.

## Input

Invoke the skill with a target and what to explore. The syntax depends on the harness: `/design-sprint` in Claude Code, `$design-sprint` in Codex, `/skill:design-sprint` in pi, and the skill name in Grok. Without a target, ask which screen, component or feature to explore and stop.

The target sets the sprint's mode:
- **Redesign:** the target exists, for example `design-sprint organizer applications list: density and grouping`. "Do nothing" keeps today's version.
- **New feature:** the target does not exist yet, for example `design-sprint new feature: bulk invite on the team page, 6 variants`. "Do nothing" means "don't add it".

A count in the request (`6 variants`) sets how many variants the first round builds. Without one, the config's `variants` sets it, else one per roster model (step 2).

A sprint explores and decides. It does not change production code. Implementing the winner is a separate task.

## 1. Frame

1. Read the project's design contract and building blocks:
   - design docs (`DESIGN.md`, a design-system README)
   - theme and token files
   - the shared component directory
   - lint rules for styling
   - the stack (framework, styling, i18n)
   - **redesign:** the target's current implementation and the data it shows
   - **new feature:** the host screen it will live on, similar flows the product already has, and the data or API it will use
2. Write a five-line brief:
   - who uses the screen
   - their one task
   - the facts it must show
   - the primary action
   - constraints such as themes, locales, devices and accessibility
3. **New feature:** fix the feature's data shape in the brief: its fields, states and limits. Every lane builds against this shape through the fixtures. If the data does not exist yet, write the shape as the fixture's type and label the previews as built on proposed data.
4. Ask at most three questions, and only if the target, its users or what a new feature must do are unclear. These are the only questions you ask in chat, because the page does not exist yet.
5. Split the work into two kinds:
   - **Variants:** whole-screen or whole-component answers. The models produce these (step 2).
   - **Decisions:** questions where exactly one property changes, such as accent use, corner radius, density, heading style or button width. You build these yourself, and each option differs from the others only in that property.

   In new-feature mode, start with variants only. A decision needs a baseline to change one property of, and a new feature has none until the user picks a direction (see Iterate).
6. Every variant set and every decision always includes **Do nothing (keep current)**. The page adds it automatically and labels it "Don't add it" in new-feature mode. Give it an honest preview of today's real screen through `current`. In new-feature mode, preview the host screen as it is today, or leave `current` out if the feature is a new screen.

## 2. Pick the models

Run `node <skill-dir>/scripts/lanes.mjs roster`, with `--variants <n>` when the request named a count. It prints the model descriptors to use and `lanes`, one `{ id, model, take }` per variant. The models come from these sources:
- **From config:** first `.design-sprint/config.json` in the project, then `~/.config/design-sprint/config.json`.
- **Default:** one lane per installed CLI (`claude`, `codex`, `grok`, `pi`) on that CLI's default model.

A descriptor is `<cli>:<model>[@<effort>]`, e.g. `claude:opus@high` or `codex:gpt-6.1-sol@high`. A config file looks like this:

```json
{ "models": ["claude:opus@high", "codex:gpt-6.1-sol@high", "grok:grok-4.7@high"], "variants": 6, "critic": "codex:gpt-6.1-sol@high", "blind": true }
```

The variant count comes from `--variants`, then the config's `variants`, then the number of models. `roster` spreads the lanes over the models in order, so no model gets a second lane before every model has one. With 3 models and 6 variants, each model builds 2.

- Use 2–4 models from different model families. Same-family models add little.
- **One model, several lanes:** when a model has more than one lane, its lanes give one opinion from several angles, not several opinions. Write one angle per lane of that model, such as "fewest steps" and "guided, with a preview before sending". Put the angle in the lane's prompt and set `angle` on its variant. Lanes of a model with only one lane get no angle, so their variants differ by the model's own judgment.
- You may build one variant yourself as an extra lane, marked `model: "self"`. Then your own model is one of the opinions, not the judge of the others.
- If only one model is available, say so and run the sprint with your own variants. Never present one model's variants as several opinions.

## 3. Open the page

Open the page before any lane starts, so the user watches the variants being built there instead of in the terminal.

1. Create `.design-sprint/<slug>/` and exclude it from git through `.git/info/exclude`.
2. Capture today's screen for `current`, either as a URL or as a screenshot saved in the sprint directory. In new-feature mode, capture the host screen without the feature. Leave `current` out when the feature is a new screen.
3. Write `.design-sprint/<slug>/sprint.json` following `<skill-dir>/references/manifest.md`, with no variants yet. A complete example is in `<skill-dir>/assets/example-sprint.json`.
   - Set `mode`, and `status.message` to what comes next, such as `Building 6 variants with 3 models. This takes a few minutes.`
   - Set `blind` from the config. Default to `true` when lanes come from different vendors, so brand does not sway the pick. The page reveals the models after submit.
   - Add the wrap-up questions with `"withSubmit": true`, so the user answers them on the Review step together with their picks and you never ask afterwards:
     - `implement`: "Implement the winner now?", options `now` ("Yes, implement it next") and `later` ("Not now"), `later` recommended;
     - `cleanup`: "What should happen to the preview files?", options `delete` ("Delete them") and `keep` ("Keep them"), `delete` recommended.
4. Start the project's dev server on a non-default port. Never take over a server the user is already running.
5. In the background, run `node <skill-dir>/scripts/serve.mjs --sprint .design-sprint/<slug> --port 4390`. It also serves the sprint directory's preview files on port 4391 (`--files-port`), a separate origin, so preview code can never act on the page.
6. Open `http://127.0.0.1:4390/` for the user (`xdg-open` on Linux, `open` on macOS). In chat, give the URL and say the sprint continues there, in one or two lines. The page explains itself.

## 4. Build

Previews are development-only artifacts that never ship:

| Stack | Where previews live |
|---|---|
| Vite | An extra root HTML entry (Vite serves it in dev and builds only `index.html`), loaded through `if (import.meta.env.DEV) await import(...)` |
| Next.js | A route under a dev-only segment that calls `notFound()` when `process.env.NODE_ENV === 'production'` |
| Storybook present | Stories under a `Design sprint/` title |
| Anything else | Static HTML inside `.design-sprint/<slug>/`, served by `serve.mjs` on its separate preview port |

Build in this order:

1. **Scaffold the shared parts first, before any lane starts:**
   - the preview entry, which loads `variant-<id>/index.<ext>` for `?variant=<id>` and reads `?theme=`;
   - the fixtures: realistic long and localized names, mixed states, an empty state.
2. **Write one lane prompt per lane** from `<skill-dir>/references/lane-prompt.md` into `.design-sprint/<slug>/lanes/<id>.prompt.md`. Every lane gets the same brief, plus its angle when its model has several lanes. Each lane owns only `variant-<id>/`, so the lanes can write in the same checkout at the same time.
3. **Write `.design-sprint/<slug>/lanes.json`** with the ids and models from `roster`'s `lanes`: `{ "cwd": "<project root, relative to this file>", "lanes": [ { "id": "A", "model": "claude:opus@high", "promptFile": "lanes/A.prompt.md", "owns": ["<preview directory>/variant-A"] } ] }`.
   - `promptFile` is relative to the sprint directory.
   - `owns` lists the lane's paths, relative to `cwd`.
4. **Run all lanes in parallel** with `node <skill-dir>/scripts/lanes.mjs run --sprint .design-sprint/<slug> --plan .design-sprint/<slug>/lanes.json`. Run it in the background if your harness limits foreground commands; lanes take minutes. The page shows each lane's progress while it runs.
   - Each lane writes `lanes/<id>.receipt.json`, plus its stdout, stderr and last message.
   - A `dropout` receipt names the reason. Record it in `dropouts`, continue with the rest, and tell the user. Never fill its slot with another model silently.
   - **Isolation differs by CLI:**
     - **Claude** lanes run `--restricted`: no code-running tools, no user or project settings, no MCP servers, and file tools confined to the project.
     - **Codex and Grok** lanes run in their CLIs' workspace sandboxes. MCP servers configured for those CLIs still load and run outside the sandbox.
     - **pi** lanes lose the shell and MCP, but pi has no sandbox, so a pi lane could still write outside the project.

     Use Codex, Grok and pi lanes only on a machine and project you trust them with.
   - **Outside changes.** The run compares git's view of changed files before and after. It writes every path changed outside all lanes' `owns` paths and the sprint directory to `lanes/outside-changes.json`. Lanes share one checkout, so such a change cannot be attributed to a lane, and it may be the user's own work. Never revert it. Ask about it on the page with a question, listing the paths.
5. **Review every completed lane's work yourself.** Set `status.message` to `Reviewing the variants` first.
   - read the files under its `owns` paths;
   - run the project's lint and type checks;
   - fix only mechanical breakage, and note the fix on the variant.

   If two lanes converged on the same direction, say so on both cards; convergence is a strong signal.
6. **Optionally, get second opinions.** If a `critic` is configured, or the variants are hard to call, send the brief plus each variant's screenshots to a model that did not build it. Store its two or three sentences in that variant's `reviews`.
7. **Build the decision options yourself.** Express each one as a local override scoped to its preview, such as a data attribute with CSS custom-property overrides. Never edit shared components, tokens or global styles during a sprint.
8. **Prove the previews stay out of production.** Run the production build and check that the preview pages and modules are absent.
9. **Publish the variants.** Add them and the decisions to `sprint.json`. Fill `label`, `intent` and `tradeoffs` from the JSON on the last line of each lane's report, and set `model` to the lane's descriptor. The page switches from progress to the first step as soon as variants appear.

## 5. Iterate

Loop until a `submit` event arrives:

1. Wait with `node <skill-dir>/scripts/wait.mjs --sprint .design-sprint/<slug>`. It prints `{ count, events }` and remembers what it handed you, so run the same command every time. Start the next wait as soon as you have handled a batch. If your harness caps foreground commands, run it in the background, or add `--timeout 540` and repeat. It returns for anything except a decision pick; decision picks arrive with the next batch.
2. Handle each event (types are in `references/manifest.md`):
   - **`pick`:** note it. The page sends a pick when the user leaves a step. In new-feature mode, a direction pick other than keep sets the decisions' baseline. Set `status.message` to `Building decision options over <id>`, then build the decisions as single-property options over the picked variant. Set `basedOn` to the variant id on each decision. Give each decision a `"keep": true` option labelled `As in <variant id>` that shows the picked variant unchanged, and use the same preview as its `current`. The page waits on a "building decision options" step until they appear. If there is nothing to decide over that variant, set `noDecisions: true` on it instead. If the user later picks another direction, build its decisions the same way, under new ids; the page shows only the decisions over the picked direction.
   - **`reprompt`:**
     1. Add `{ "feedbackId": <id>, "status": "working", "note": "<what you are doing>" }` to `requests` immediately, for example `Rebuilding B with sticky headers. This takes a few minutes.`
     2. Route the request to a lane:
        - `variant:<id>` goes back to the model that built that variant, so the variant keeps its voice:
          1. Pick the next free letter as the new id.
          2. Write a complete prompt file `lanes/<new id>.prompt.md` from the lane template: the full brief plus the revision line quoting the user's text.
          3. Add the lane to `lanes.json` with its `model`, `promptFile` and `owns`.
          4. Run `node <skill-dir>/scripts/lanes.mjs run --sprint .design-sprint/<slug> --plan .design-sprint/<slug>/lanes.json --only <new id>`.
          5. On the new variant in `sprint.json`, set `basedOn` to the source id and `prompt` to the user's text.
        - `direction` ("none of these") becomes a new lane, built the same way, on the roster model that has built the fewest variants.
        - `decision:<id>` gets a new option, which you build yourself.
        - `sprint` is a general change, which you make yourself.
     3. Keep the earlier variants unless the user asked to replace one; then set `retired: true` on it.
     4. Increment `round` and set the request to `done` with a note that names what changed and where to look, for example `Added E, based on B, with sticky category headers.`
     5. If the request is ambiguous, add a question with `about` set to the request's id and wait for its `answer`. If you will not do the request, for example because it asks to change production code during the sprint, set it to `declined` with the reason in `note`.
   - **`answer`:** the user's answer to one of your questions. Continue whatever the question was about.
   - **`submit`:** stop the loop. Its `answers` hold the wrap-up answers.
3. Batch the re-prompts that arrive together into one round. Verify every new preview renders in every theme and width before marking its request `done`.

## 6. Close

The user is still on the page, which now shows their answer and what you are doing with it.

1. Set `status.message` to what you are doing, then record the decisions where the project keeps design rules, for example DESIGN.md. Record "keep" picks too: they are decisions.
2. Stop the dev server you started.
3. Set `done.message`: what you recorded, which model made the chosen variant, every dropout, and what happens next. In new-feature mode, `Direction: keep current` means do not build the feature.
4. `serve.mjs` exits by itself once the page has loaded `done`; stop it yourself if it is still running, for example because the tab was closed. Then, if the `cleanup` answer is `delete`, delete the preview files and `.design-sprint/<slug>/`.
5. In chat, report the answer line, which model made the chosen variant, and every dropout. Next to each pick, give its consequence in one sentence.
6. If the `implement` answer is `now`, implement the winning variant as a normal task with the project's usual tests and review. Otherwise stop. Never implement it inside the sprint.

## Rules

- **Blind sprints:** never name a model in a note, `status.message` or question until the user submits.
- **Honest previews:** label approximations on the preview itself. "Do nothing" shows what exists today.
- **A fair comparison:** every lane gets the same brief, fixtures, themes and widths. Only angles differ, and only between lanes of one model. Do not polish your favourite more than the others.
- **One owner per path:** each lane writes only its own directory. You own the shared scaffold and the decision options.
- **Safety:** bind servers to 127.0.0.1. Never load production data into previews, and never ship preview code.
