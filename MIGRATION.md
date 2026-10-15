# Migration notes

`reference/` is the original Python project. The Node implementation removes `apps/character-game` and keeps the Bridge Console as a separate Svelte app.

## Ported

1. Native Node HTTP server and OpenAI-compatible chat facade.
2. Request capture parsing, environment auth and encrypted `enc:v1:` account files.
3. Filesystem artifacts and SQLite admin store.
4. ChatGPT Web payload/header shaping, SSE normalization, sentinel/prepare refresh and proof-of-work.
5. Account discovery, failover, routing strategies and per-account concurrency.
6. Chat, image generation/edit, vision, files, usage snapshot and operation routes.
7. Console admin routes, opencode config management and CLI essentials.
8. Shared-host and Docker deployment packaging.

## Deliberate compatibility boundary

The upstream Python transport uses `curl_cffi` browser impersonation and a widget/WebSocket protocol for native Deep Research. Node uses the platform `fetch` implementation and exposes `chatgpt-deep-research` as a standard ChatGPT Web compatibility flow that saves a Markdown report. If a particular account or upstream rollout requires native widget Deep Research, keep the Python reference service for that feature or add a Node WebSocket transport behind the existing provider seam.

## Verification

```sh
npm test
npm run build:all
```

The root build contains no Character Game source, ports, environment variables or deployment service.
