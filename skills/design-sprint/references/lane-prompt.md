# Lane prompt template

Copy this into `.design-sprint/<slug>/lanes/<id>.prompt.md` for each lane and fill in the angle-bracket parts. Every lane gets the same brief, so the variants differ by the models' own judgment. Only `<lane id>`, the owned paths and, on a re-prompt, the change request differ.

---

You are one of several designers, each working on a different model, who answer the same brief independently. Produce one complete variant of the UI described below. Do not hold back for the sake of the others. The user compares the results side by side and picks one.

## Brief

<the five-line brief: who uses it, their one task, the facts it must show, the primary action, constraints>

## Project design system

Read these first:
- <design docs, e.g. DESIGN.md>
- <token and theme files>
- <shared component directory>
- <the target's current implementation>

Use the project's real shared components, tokens and helpers, with their existing props.

## Your files

You are lane `<lane id>`. Create or edit only these paths, which are the same as your `owns` entry in `lanes.json`:
- `<preview directory>/variant-<lane id>/` (create it)

Other designers are writing other directories in the same checkout at the same time. Do not touch anything outside your paths. In particular, leave shared components, tokens, global styles, lockfiles and other lanes' directories alone. Do not run formatters or codemods over the whole repository.

The preview entry `<entry file>` already loads `variant-<lane id>/index.<ext>` when the page is opened with `?variant=<lane id>`. Export the variant as described there.

## Fixtures

Use `<fixture file>`. Show the long and localized names, the mixed states and the empty state it contains. Make no network requests and no writes.

## Rules

- **Themes and widths:** support the themes `<themes>` and widths of 390 px and 1280 px.
- **Project checks:** the project's lint and type checks must pass on your files: `<commands>`. Do not add baseline or allow-list entries.
- **No helpers:** do not start other agents or design sprints.
- **Done means rendered:** finish only when the variant renders. If you cannot run it, say so.
<on a re-prompt: "Revise variant <source id> into a new variant at your paths. The user asked: «<text>». Keep what the request does not mention.">

## Report

End with exactly one JSON object on the last line:

```json
{"label": "<2–4 words>", "intent": "<one sentence>", "tradeoffs": "<one sentence>", "rejected": "<directions you considered and why you rejected them>"}
```
