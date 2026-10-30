# Riverside Running Club site

A small single-page site with no build step.

```bash
node server.mjs --port 5173 --api https://api.riverside-run.example/api
```

`--api` sets the API base URL the page calls (`/events/upcoming`, `/stats/club`, `/graphql`, and the `/live` WebSocket). The production API holds real member data, so never point local runs at it for testing.
