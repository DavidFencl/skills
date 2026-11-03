---
name: add-frontend
description: "Add a custom web frontend to a DepthAI v3 (Luxonis OAK camera) Python app, the way Luxonis apps do it. Copies a bundled React and Vite template that uses @luxonis/depthai-viewer-common for live streams and @luxonis/ui-components for controls, builds one control per Python service, and edits the Python code so the app serves the built page in peripheral mode, while oakapp.toml serves it on an OAK4 in standalone mode. Checks current Luxonis package versions through the Luxonis Context MCP server. Use for 'add a frontend to my OAK app', 'give this DepthAI app a web UI', 'custom frontend for this oakapp', or replacing the default Visualizer with an app-specific page."
---

# Add a frontend

Give a DepthAI v3 Python app its own web page: live streams of the app's topics, and controls that call the app's services. The page follows the Luxonis custom-frontend examples in `luxonis/oak-examples` (`custom-frontend/raw-stream`).

`<skill-dir>` below means the directory that contains this file. The scripts need only Node. Building the page needs npm.

## How the pieces fit

- The Python app creates `dai.RemoteConnection(serveFrontend=False)`. It publishes topics with `addTopic` and services with `registerService` over a WebSocket on port 8765.
- **Peripheral mode** (the app runs on a computer with the camera attached): `serve_frontend()` from `frontend_server.py` serves `frontend/dist` on port 8082. The page then connects to `ws://<host>:8765`.
- **Standalone mode** (the app runs on an OAK4): `[static_frontend]` in `oakapp.toml` builds `frontend/` on the device. The web server in the `luxonis/oakapp-base` image serves the result and forwards `/dai` to port 8765. `serve_frontend()` does nothing there.

`references/standalone.md` has the details of standalone mode. `references/frontend.md` has the frontend API and control patterns.

## 1. Read the app

1. Find the entry script, the one that builds the pipeline. If the app uses DepthAI 2, stop and say that it needs DepthAI 3 first. Signs of DepthAI 2: its requirements pin `depthai` below 3, or it opens the device with `dai.Device(pipeline)`.
2. List the names passed to `addTopic` and `registerService`, and any existing `RemoteConnection`.
3. Note whether `oakapp.toml` exists and which `[base_image]` it uses.
4. If the app already has a `frontend/` folder, stop. This skill adds a frontend. It does not replace one.
5. Decide what the page shows and controls. Take it from the user's request. If the request names nothing, propose one stream view per topic and one control per service, and confirm that in one question.

## 2. Check the current Luxonis versions

The template pins the `@luxonis/*` packages to the versions in `custom-frontend/raw-stream/frontend/package.json` in `luxonis/oak-examples`, as of DepthAI 3.11. Before you scaffold, compare them with today's:

- **With the Luxonis Context MCP server:** call its `luxonis-public.get_example` tool (`search` gives the exact path) with `path: "custom-frontend/raw-stream"` and `files: ["frontend/package.json", "requirements.txt"]`. It also takes a one-sentence `context`, and the `conversation_id` that its first answer returns.
- **Without it:** run `gh api repos/luxonis/oak-examples/contents/custom-frontend/raw-stream/<file> -H 'Accept: application/vnd.github.raw'` for the same two files.

Compare the `@luxonis/*` pins with `<skill-dir>/assets/frontend/package.json`. If the examples pin newer versions, and the app's `depthai` version is at least the one in their `requirements.txt`, use the newer pins after you scaffold. Edit `frontend/package.json`, then run `npm install` to refresh the lockfile. The viewer library speaks the protocol of one DepthAI version, so take the versions from the examples, never the newest ones on npm. For questions about the DepthAI API or `oakapp.toml`, use `luxonis-public.search_docs`, which searches docs.luxonis.com.

## 3. Scaffold

```bash
node <skill-dir>/scripts/scaffold.mjs --app <app dir> [--entry <entry script, default main.py>] [--title "<page title>"]
```

The script does the following:
- Copies the template to `<app>/frontend/`.
- Writes `frontend_server.py` next to the entry script.
- If the app has `oakapp.toml`, appends `[static_frontend]` and installs Node in `prepare_build_container`, and keeps `node_modules/` out of the package through `.oakappignore`.

Pass `--title` with the app's name as a person would write it. Without it, the title comes from the folder name. The script never overwrites anything. It prints a JSON summary. Act on each of its `notes`:
- **The app uses another base image.** Nothing serves the page in standalone mode. Ask the user before you change the base image.
- **The app already installs Node its own way.** Make sure it installs Node 24 with nvm, because the build steps use nvm.

## 4. Wire the Python app

Edit the entry script:

```python
from frontend_server import serve_frontend

serve_frontend()
visualizer = dai.RemoteConnection(serveFrontend=False)
```

- Call `serve_frontend()` before the pipeline starts. `serve_frontend(host, port)` takes the app's own `--ip` and `--port` options when it has them. Keep port 8082 as the default, because the page finds the WebSocket from it.
- Pass `serveFrontend=False` to every `RemoteConnection`, and drop its `httpPort`, which only sets the default Visualizer's port. Without `serveFrontend=False`, the default Visualizer takes port 8082.
- Add `visualizer.addTopic("<label>", <output>)` for each output the page shows. The label is what the user sees.
- Add `visualizer.registerService("<Name>", handler)` for each control and each panel of data. The handler takes the value that the page sends and returns a JSON-serializable dict. To report a failure, return `{"error": "<message>"}`, and the page shows it.
- Keep the app's loop. It must keep calling `visualizer.waitKey(1)` while the pipeline runs.

## 5. Build the page

- In `frontend/src/streams.ts`, list in `STREAMS` the topics that the page opens when it connects, by their exact `addTopic` names. The layout hides the viewer's stream picker, so a topic missing from `STREAMS` stays closed. For names set at run time, such as camera sockets, list the names the app produces, for example `CAM_A`.
- In `frontend/src/services.ts`, add one entry to `SERVICES` per registered service, with the exact Python name.
- In `frontend/src/Controls.tsx`, add one control per service that changes something, with `useService()`. `references/frontend.md` has a pattern for a button, a switch, a slider, a choice and a text field.
- Give a service that only returns data its own panel component, which loads the data once connected (the `getSettings` effect in `references/frontend.md`). Put it in the side column in `App.tsx`, next to `<Controls />`.
- Delete `Controls.tsx` and its use in `App.tsx` when the app has nothing to control.
- Build every control and every piece of text from `@luxonis/ui-components`. Use Tailwind classes only for layout, and put layout that changes with the screen width in `src/index.css` (see `references/frontend.md`). Never hard-code a color.
- Use relative paths only. Luxonis Hub serves the app under `/<version>/`, and an absolute path breaks there.
- Never list the app's services in `activeServices`. The viewer calls each listed service every 10 seconds with no arguments.

## 6. Build and check

```bash
cd <app dir>/frontend && npm ci && npm run build
node <skill-dir>/scripts/check.mjs --app <app dir>
```

`check.mjs` prints JSON and exits 1 on errors:
- Python that never serves the page.
- A `RemoteConnection` that would serve the default Visualizer.
- A stream or a service that the page uses and the Python app never publishes or registers.
- An `oakapp.toml` that would not build or serve the page on the device.

`npm ci` installs exactly the lockfile's versions and leaves the lockfile as it is. npm may report vulnerabilities in the dependencies of the Luxonis packages. Do not run `npm audit fix`, because it changes the pinned versions.

Fix every error. Report each warning you leave.

If a camera is attached, run the app in peripheral mode, for example `python3 main.py`, and open `http://localhost:8082`. Confirm that each stream plays and that each control gets its answer. Ask before you use a camera that another app is using. Run the app on a device in standalone mode, with `oakctl app run`, only when the user asks.

## 7. Report

Update the app's README, and its AGENTS.md when it has one. Peripheral mode now needs the frontend built first (`npm ci && npm run build` in `frontend/`), and the page is at `http://localhost:8082`.

Tell the user:
- What the page shows and controls.
- Which files you added and changed.
- How to run it in each mode. In peripheral mode, open `http://localhost:8082`. In standalone mode, the device serves the page.
- What `check.mjs` reported.
- What you did not verify, for example standalone mode or a stream you could not see without a camera.
