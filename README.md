# gpt-bridge-node

Node.js + TypeScript rewrite of [`suphotP/chatgpt-api`](https://github.com/suphotP/chatgpt-api). The **Character Game is intentionally excluded**; this repository contains the API bridge and Bridge Console only.

## Included

- Native Node HTTP API with `HOST`, `PORT`, bearer authentication, CORS and body limits.
- OpenAI-compatible `POST /v1/chat/completions` with JSON and SSE responses.
- Request-capture loading, encrypted `enc:v1:` captures, account discovery, failover and per-account concurrency.
- ChatGPT Web sentinel/prepare refresh, proof-of-work generation, browser-shaped headers, SSE normalization and cancellation.
- Image generation/edit, multimodal vision/OCR, local artifact files and SQLite metadata.
- Console admin endpoints for captures, accounts, settings, tests, artifacts and opencode config injection/ejection.
- `/health`, `/v1/models`, operation status/cancel and capture-derived usage/capability reporting.
- Svelte Bridge Console under `apps/bridge-console` and a Node CLI.

`chatgpt-deep-research` is exposed as a compatibility mode that runs the standard ChatGPT Web conversation flow and saves a Markdown report. The upstream Python project’s widget/WebSocket Deep Research session protocol is intentionally not claimed as implemented by this Node port.

## Requirements

- Node.js **22 or newer**. The admin store uses built-in `node:sqlite`.
- A ChatGPT Web request capture or access token/cookie set that you are authorized to use.

## Run on a shared Node host

```sh
npm install
cp .env.example .env
# edit CHATGPT_API_KEY and CHATGPT_REQUEST_PATH or account captures
npm run build
npm start
```

Use the host’s Node application runner with startup file `dist/index.js` and Node 22+. The service listens on `127.0.0.1:8000` by default. For a reverse proxy/shared host set `HOST=0.0.0.0`, use the assigned `PORT`, and set `CHATGPT_PUBLIC_BASE_URL` to the public `/v1` URL.

## Account captures

Paste a complete copied ChatGPT Web request in the console, or save it as:

```text
secrets/accounts/main/chatgpt-request.txt
```

Set `CHATGPT_ACCOUNT=main`, or use `CHATGPT_ACCOUNTS=main,plus`. Captures may be plaintext for legacy compatibility; the console saves new captures encrypted with the owner-only key in `CHATGPT_ACCOUNTS_DIR/.master.key`. Never commit `secrets/`.

## API examples

```sh
curl "$CHATGPT_PUBLIC_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $CHATGPT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-web/auto","messages":[{"role":"user","content":"สวัสดี"}]}'

curl "$CHATGPT_PUBLIC_BASE_URL/images/generations" \
  -H "Authorization: Bearer $CHATGPT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","prompt":"a watercolor mountain landscape","response_format":"url"}'
```

Images for `/v1/images/edits` and `/v1/chatgpt/vision` may be data URLs, base64 strings or local paths supplied by a trusted local client.

## Console and CLI

```sh
npm run build:console
npm --prefix apps/bridge-console run dev -- --host 0.0.0.0

npm run build
node dist/cli.js doctor
node dist/cli.js server
node dist/cli.js admin accounts
node dist/cli.js api chat --prompt 'Say hello' --model chatgpt-web/auto
node dist/cli.js secrets check
```

Open the console at `http://127.0.0.1:5174`, point it at the API base URL ending in `/v1`, and use the bearer key from `.env`.

## Docker

```sh
cp .env.example .env
docker compose up --build -d
```

Compose runs only the Node API and persists `secrets/` and `outputs/`. The Character Game is not copied, built or started.

## Checks

```sh
npm test
npm run build:all
```

`reference/` is a shallow local clone used for behavior comparison and is ignored by the root Git repository. Account captures contain live credentials; use only accounts and hosts you own or are explicitly authorized to operate.
