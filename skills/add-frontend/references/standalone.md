# Standalone mode on an OAK4

In standalone mode, the app runs on the camera as an oakapp, and the device builds and serves the frontend. RVC2 devices have no standalone mode, so on them the app runs in peripheral mode only.

## What `scaffold.mjs` adds to oakapp.toml

```toml
prepare_build_container = [{ type = "RUN", command = "bash -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . \"$HOME/.nvm/nvm.sh\" && nvm install 24'" }]

[static_frontend]
dist_path = "./frontend/dist"

[static_frontend.build]
source_path = "./frontend"
steps = ["bash -c 'ulimit -n $(ulimit -Hn); cd /app/frontend && export NODE_OPTIONS=--max-old-space-size=4096 && . $HOME/.nvm/nvm.sh && npm install && npm run build'"]
```

| Key | Meaning |
| --- | --- |
| `prepare_build_container` | Installs Node 24 in the container that builds the app. It is a top-level key, so it goes before the first table. |
| `[static_frontend] dist_path` | The folder the device serves. |
| `[static_frontend.build] source_path` | The folder copied into the build container, at `/app/frontend`. |
| `[static_frontend.build] steps` | Builds the frontend there. The `ulimit` and `NODE_OPTIONS` settings work around the build container's low limits. |

`.oakappignore` lists `node_modules/`, so the package carries the sources and the device installs the packages itself.

## What the device does

1. `oakctl app build` or `oakctl app run` builds `frontend/` in the build container, then copies `frontend/dist` into the app.
2. When the app starts, the device sets `OAKAPP_STATIC_FRONTEND_PATH` to the built files and `OAKAPP_STATIC_FRONTEND_PORT` to the port it serves them on.
3. The web server in the `luxonis/oakapp-base` image serves the files over HTTPS on that port, and forwards `/dai` to the app's WebSocket on port 8765.

`serve_frontend()` returns `None` when `OAKAPP_STATIC_FRONTEND_PORT` is set, so the app never serves the page twice. Only the `luxonis/oakapp-base` image serves `[static_frontend]`. With another base image, the page has no server in standalone mode. Changing the base image changes the app's whole runtime, so ask the user first.

## Luxonis Hub

Hub serves the app under `/<version>/`, for example `/1.2.0/`. `main.tsx` reads that prefix for the router, and `base: ''` in `vite.config.ts` keeps asset paths relative. An absolute path such as `/logo.svg` breaks the page there. Hub connects over WebRTC, and passes its connection details in the page URL.

## Running it

- `oakctl app run <app dir>` builds the app and runs it on the device.
- These commands change the camera. Run them only when the user asks.
