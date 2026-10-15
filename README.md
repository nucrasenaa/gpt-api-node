# gpt-bridge-node

Node.js + TypeScript rewrite of the Python bridge in `reference/`.

The **Character Game is intentionally removed**. The target is a small Node
service that can run on a Node-enabled shared host, while keeping the existing
OpenAI-shaped API routes where practical.

## Current milestone

Implemented:

- Node native HTTP server with `PORT`/`HOST` support.
- Bearer-key authentication and CORS handling.
- `GET /health`.
- `GET /v1/models`.
- `GET /v1/chatgpt/admin/status`.
- `GET /v1/chatgpt/admin/settings`.
- `POST /v1/chat/completions` with JSON and SSE response modes.
- Environment and plaintext copied-request capture loading.
- Existing Svelte Bridge Console copied into `apps/bridge-console` (Character
  Game is not copied).
- No `apps/character-game`, port 3000, or `CHATGAME_*` settings.

The ChatGPT Web transport is deliberately isolated in
`src/provider/chatgpt-web.ts`. Proof-token refresh, image/file routes, account
failover, encrypted capture compatibility, and the full admin API remain
migration work; the server returns provider errors rather than pretending those
features are complete.

The copied console is a reference UI during the migration. Its advanced admin
screens will stay disabled or incomplete until the corresponding Node routes
are ported.

## Run

```sh
npm install
cp .env.example .env
npm run build
npm run build:console
npm start
```

Health check:

```sh
curl http://127.0.0.1:8000/health \\
  -H 'Authorization: Bearer local-dev-key'
```

## Reference

`reference/` is a shallow clone of
[`suphotP/chatgpt-api`](https://github.com/suphotP/chatgpt-api). It is kept out
of the root project git history and is used only as the behavior reference.

Account captures contain live credentials. Keep them outside git and do not
deploy them to a shared host unless the host and account use are explicitly
trusted and authorized.
