# Mocking missing services

A screenshot of a skeleton or an error toast tells a reviewer nothing about a change. Mocks give the pages realistic data when the backend or a third-party service is missing, slow, or unsafe to call, and they make every capture repeatable: both sides get identical responses, so any difference comes from the frontend code.

Contents: the loop, reviewing a draft, mock fields, states, beyond REST (GraphQL, WebSocket, Socket.IO, SSE, images, third-party scripts, auth and flags, server-side rendering), reusing project fixtures, pitfalls.

## The loop

1. **Isolate.** Point the frontend's API URL at a closed loopback port (`VITE_API_URL=http://127.0.0.1:4399/api` or the project's equivalent) and set `"allowHosts": []`, `"servicePolicy": "mock-only"` and `"placeholderImages": true` in the manifest. Requests then never leave the machine: other hosts are blocked, WebSockets included, API calls no mock answers are blocked even on the frontend's own origin (where a dev-server proxy could forward them), and blocked images become placeholders.
2. **Capture once without mocks.** Each shot prints its unanswered calls, and `<report-dir>/unanswered.json` lists every endpoint once: method, origin, path, reasons, example URLs, request body, and which shots called it. Fetch, XHR, EventSource and WebSocket calls count when they fail, are blocked, return 404 or 5xx, or get an HTML page back (a dev server's fallback for unknown paths).
3. **Draft.** `node <skill-dir>/scripts/mocks.mjs draft <report-dir> --project <tsconfig.json or jsconfig.json>` writes `<report-dir>/mocks.draft.json` (`--out` to choose). For each endpoint it finds the code that calls it (URL literals and templates, with constant prefixes resolved), takes the response type from the call's type argument or the calling function's declared return type (unwrapping `Promise` and client wrappers such as axios's `{ data }`), and builds a value of that type. A solution-style tsconfig is expanded into its references. Without `--project` or without a TypeScript compiler, it falls back to a text search and leaves `TODO` bodies.
4. **Review** the draft (below) and list it in the manifest, which lives in the same report directory: `"mocks": ["mocks.draft.json"]`.
5. **Recapture** and repeat until no shot lists unanswered calls that matter.

`mocks.mjs find <url> --method GET --project <tsconfig>` shows the call sites, response types and files that mention one endpoint. `mocks.mjs sample <TypeName> --project <tsconfig>` prints a value of any named type, for variants.

## Reviewing a draft

The values are plausible and fictional, derived from field names and types: people's names for `displayName`, venues for `locationName`, upcoming dates for `startsAt`, past dates for `createdAt`, placeholder data-URI images for `avatarUrl`, enum members cycled across list items, `false` for flags such as `disabled`, `isArchived` or a maintenance switch. Check:

- **Gating flags** that hide whole screens: maintenance modes, feature flags, permissions, `isLoggedIn`. A wrong value shows the wrong screen on both sides and hides the change.
- **Variants** the change displays: enum values, statuses, roles, empty or long lists.
- **Anything the diff renders**: the new field must be present and look like real data.
- **`TODO` entries**: the note names the call sites and fixtures that mention the endpoint. Write the body from the code that reads it.

Keep data fictional. Never paste real users' data from a database, log or production response.

## Mock fields

Each mock answers requests whose URL matches `url`, a glob where `*` stays within one path segment and `**` crosses segments. The query string is ignored unless the glob contains `?`. `urlRegex` matches the full URL instead. Mocks get CORS headers and answer preflight requests, so an API on another origin works.

Order: a shot's mocks, then top-level mocks, the last listed winning; then the HAR file; then `servicePolicy` and `allowHosts`; then the network. A mock file in the `mocks` list is a JSON array of mock entries, and its relative paths (`file`, `handler`) resolve from the file's own directory.

| Field | Meaning |
| --- | --- |
| `url`, `urlRegex` | What to answer. Pin it to the API origin, such as `http://127.0.0.1:4399/api/events/**`. |
| `method` | `"POST"` or a list. Omit to answer every method. |
| `query` | Partial match on query parameters: `{ "page": "2" }`; a list requires every value; `null` requires the parameter to be absent. |
| `graphql` | GraphQL operation name, taken from the body's `operationName` or the query document (`query Viewer {`), or the URL for GET requests. |
| `requestJson` | Partial match on the JSON request body: every key given must be equal. |
| `requestText` | Substring the raw request body must contain. |
| `json` | Response body, serialized as JSON. |
| `file` | Response body read from a file. `.json` files get a JSON content type. |
| `body`, `contentType`, `headers` | Raw body and headers, such as a JavaScript stub with `"contentType": "text/javascript"`. |
| `status` | HTTP status, default `200`. Use 4xx and 5xx for error states. |
| `delayMs` | Wait before answering. |
| `pending` | Never answer, to capture a loading or sending state. The quiet-network wait ignores these requests. |
| `abort` | Fail the request as a network error, such as `"connectionrefused"` or `"timedout"`. |
| `times` | Answer only the first N matching requests, then fall through. |
| `sse` | Server-sent events: a list of `{ "event", "data", "id" }` or plain data. The stream sets a long `retry` so EventSource does not reconnect during the capture. |
| `image` | A placeholder picture: `true` or `{ "width", "height", "label" }`. |
| `handler` | `"handlers.mjs#exportName"`: a function `(request, state)` returning a response object (`status`, `json`, `body`, `headers`, `sse`, `pending`, and so on) or `undefined` to fall through. `request` has `method`, `url`, `path`, `query`, `headers`, `body` and parsed `json`. `state` is shared by all handlers during one capture of one side, so a POST can change what the next GET returns. |
| `resourceTypes` | Answer only these Playwright resource types, such as `["script"]`. |
| `websocket` | A WebSocket URL glob instead of `url` (below). |
| `name`, `note` | Labels shown in the report and in drafts. |

A mock with a data body (`json`, `file`, `sse`, `status`, `handler`) never answers documents, scripts, stylesheets, images or fonts. A broad glob such as `**/api/**` would otherwise also replace dev-server source modules like `/src/app/api/user.api.ts` and break the app; the report names any mock that matched such requests. Set `contentType`, `image` or `resourceTypes` to answer those types on purpose.

## States

Add mocks to a shot to show one state without touching the others:

```json
{ "id": "events-empty", "label": "Home › events, empty", "path": "/", "mocks": [{ "url": "http://127.0.0.1:4399/api/events/upcoming", "json": { "items": [], "total": 0 } }] }
{ "id": "events-error", "label": "Home › events, server error", "path": "/", "mocks": [{ "url": "http://127.0.0.1:4399/api/events/upcoming", "status": 503, "json": { "message": "Service Unavailable" } }] }
{ "id": "report-sending", "label": "Report dialog, sending", "path": "/", "new": true, "mocks": [{ "url": "http://127.0.0.1:4399/api/support-reports", "method": "POST", "pending": true }], "steps": [{ "click": "text=Report a problem" }, { "fill": "textarea", "value": "The results table is empty on my phone." }, { "click": "text=Send report" }] }
```

For long-text states, put long strings in the data rather than editing the page.

## Beyond REST

- **GraphQL**: one endpoint, many operations. Give each operation its own mock with `graphql` and a `json` of `{ "data": ... }`; errors are `{ "errors": [{ "message": "..." }] }` with status 200. The draft matches operations by name and finds the call site from the operation's document.
- **WebSocket**: `{ "websocket": "ws://127.0.0.1:4399/live", "send": [{ "type": "presence", "online": 42 }], "onMessage": [{ "match": { "type": "subscribe" }, "send": [{ "type": "snapshot", "items": [] }] }] }`. `send` frames go out on connect (after `delayMs`); each `onMessage` rule replies when a client message contains the `match` string or matches it as partial JSON. Objects are sent as JSON text. The draft samples the message type when the code hands messages to a typed callback.
- **Socket.IO**: the client starts with HTTP long-polling in Engine.IO framing (`/socket.io/?EIO=4&transport=polling`), so a plain `websocket` mock never sees it. Prefer the app's own mock or test mode. Otherwise answer the polling URL with a `handler` that speaks Engine.IO (an open packet `0{...}` with `"upgrades": []`, the namespace connect `40`, events as `42["name",data]`, later polls held with `pending`), and check the frames against the client's protocol version. This recipe is not covered by the skill's tests.
- **Server-sent events**: `{ "url": "http://127.0.0.1:4399/api/stream", "sse": [{ "event": "update", "data": { "count": 3 } }] }`.
- **Images and CDNs**: `"placeholderImages": true` covers images from blocked hosts. Use `image` for a specific size, or `file` for a real asset from the repository.
- **Third-party scripts** (maps, payments, chat, analytics): `allowHosts` blocks them and the capture details list them. When the page breaks without one, stub its global in an `initScripts` entry, or answer the script URL with `body` and `"contentType": "text/javascript"`. Keep stubs minimal: they exist so the page can render, not to change what it shows.
- **Auth and sessions**: mock the session endpoint (`/api/me`) and put the token or flag the app reads in `localStorage` or `storageState`, so no real login is needed.
- **Feature flags**: mock the flag service's endpoint, or set the flag in `localStorage`, identically on both sides.
- **Server-side rendering** (Next.js server components, Remix loaders, Nuxt, SvelteKit): the server fetches data, out of reach of in-browser mocks. Run `node <skill-dir>/scripts/mocks.mjs serve <mocks.json or manifest.json> --port 4399` on the API port the mocks are pinned to, point the server's API variable at it, and keep the browser-side mocks for per-shot variants. It answers HTTP mocks, including handlers and SSE, accepts any host name for its port, logs every request, and returns 404 for unmocked paths; it skips WebSocket mocks. Stop it when done.
- **Service workers**: blocked by default (`serviceWorkers`), because a worker can answer requests itself and bypass every mock.

## Reuse what the project has

Look before writing mocks by hand:

- MSW handlers (`src/mocks/handlers.ts`) or a mock mode in the dev server: start both sides with it enabled.
- End-to-end fixtures (`e2e/fixtures/*.json`, Playwright `page.route` bodies, Cypress `fixtures/`): point `file` at them.
- Storybook stories with `args` or loaders, and OpenAPI examples.
- A HAR recorded against a disposable backend: set `har`.

`mocks.mjs find <url>` and the `TODO` notes in a draft list files that mention an endpoint.

## Pitfalls

- **Query strings**: apps often append `?locale=en` or cache busters. Globs ignore the query unless they contain `?`; use `query` to tell variants apart.
- **Own-origin calls**: a relative API path such as `/api/settings` hits the dev server, which may answer with its HTML fallback page. The report lists such calls with an origin of `''`, and drafts use `**/api/settings`.
- **CORS**: mocks answer preflights and echo the request's origin. A real backend on another port may not, which shows up as unanswered calls.
- **Both sides**: mocks are installed per capture, so `times` counters and handler state start fresh on each side.
- **Pin to the origin**: prefer `http://127.0.0.1:4399/api/**` over `**/api/**`.
