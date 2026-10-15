# gpt-api-node

`gpt-api-node` is a Node.js + TypeScript API bridge that exposes an
OpenAI-compatible interface for an authorized ChatGPT Web account. It is a
clean Node rewrite of [`suphotP/chatgpt-api`](https://github.com/suphotP/chatgpt-api).
The upstream **Character Game** feature is intentionally excluded.

> This project is not the official OpenAI API. Use it only with accounts,
> request captures, hosts, and clients that you own or are explicitly
> authorized to operate. Do not commit browser cookies, bearer tokens, or
> encrypted account files.

## What is included

- Node.js HTTP server with CORS, bearer authentication, body limits, and
  configurable host/port.
- OpenAI-compatible chat completions with JSON and Server-Sent Events (SSE).
- ChatGPT Web request-capture loading with encrypted `enc:v1:` account files.
- Browser-shaped request payloads, ChatGPT Web prepare/sentinel refresh, proof
  handling, cookie refresh, SSE normalization, and cancellation.
- Multiple-account discovery, account selection/failover, and per-account
  concurrency limits.
- Image generation/edit endpoints, vision/OCR helpers, local artifacts, and
  SQLite metadata.
- Admin endpoints for captures, accounts, settings, tests, artifacts, and
  OpenCode configuration injection/ejection.
- Optional Svelte Bridge Console under `apps/bridge-console`.
- A Node CLI for diagnostics, server startup, account inspection, and API
  testing.

`chatgpt-deep-research` is provided as a compatibility mode over the standard
ChatGPT Web conversation flow and saves a Markdown report. The upstream
Python project's widget/WebSocket Deep Research session protocol is not
claimed as implemented by this Node port.

## Requirements

- Node.js **22 or newer**. The admin store uses the built-in `node:sqlite`.
- A ChatGPT Web request capture or access token/cookie set that you are
  authorized to use.
- Docker Compose v2 for the container workflow.

## Quick start

```sh
git clone https://github.com/nucrasenaa/gpt-api-node.git
cd gpt-api-node

npm install
cp .env.example .env
# Edit .env and set a strong CHATGPT_API_KEY.

npm test
npm start
```

The API listens on `http://127.0.0.1:8000` by default.

### Configure an account capture

The preferred setup is to copy a complete request from an authorized ChatGPT
Web browser session and save it through the admin endpoint. The capture may
contain live credentials, so keep it local and never paste it into source
control, tickets, or public chat.

```sh
curl -X POST http://127.0.0.1:8000/v1/chatgpt/admin/captures/save \\
  -H "Authorization: Bearer $CHATGPT_API_KEY" \\
  -H 'Content-Type: application/json' \\
  --data "$(node -e 'const fs=require(\"fs\"); console.log(JSON.stringify({account:\"main\",capture:fs.readFileSync(\"chatgpt-request.txt\",\"utf8\")}))')"
```

New captures are encrypted by default and stored at:

```text
secrets/accounts/main/chatgpt-request.txt
```

The encryption key is kept in `secrets/accounts/.master.key`. Persist the
entire `secrets/` directory when deploying with Docker. Alternatively, a
legacy plaintext capture can be placed at the same path, but encrypted
storage is strongly recommended.

Select one account explicitly:

```dotenv
CHATGPT_ACCOUNT=main
```

Or configure a comma-separated pool:

```dotenv
CHATGPT_ACCOUNTS=main,plus
CHATGPT_ACCOUNT_STRATEGY=auto
```

## API usage

All protected routes use the API key configured by `CHATGPT_API_KEY`.

### Chat completions

```sh
curl http://127.0.0.1:8000/v1/chat/completions \\
  -H "Authorization: Bearer $CHATGPT_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "chatgpt-web/auto",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

Streaming is supported with the usual OpenAI-compatible option:

```sh
curl -N http://127.0.0.1:8000/v1/chat/completions \\
  -H "Authorization: Bearer $CHATGPT_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "chatgpt-web/auto",
    "stream": true,
    "messages": [{"role": "user", "content": "Write a short greeting."}]
  }'
```

### Supported routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health and provider status |
| `GET` | `/v1/models` | OpenAI-compatible model list |
| `POST` | `/v1/chat/completions` | Chat JSON or SSE |
| `POST` | `/v1/images/generations` | Generate an image |
| `POST` | `/v1/images/edits` | Edit an image |
| `POST` | `/v1/chatgpt/vision` | Vision/OCR helper |
| `GET` | `/v1/chatgpt/operations/{id}` | Read an operation |
| `POST` | `/v1/chatgpt/operations/{id}/cancel` | Cancel an operation |
| `GET` | `/v1/chatgpt/usage` | Capture-derived account capabilities |
| `GET` | `/v1/chatgpt/admin/status` | Admin/runtime status |
| `GET` | `/v1/chatgpt/admin/accounts` | Discover configured accounts |
| `POST` | `/v1/chatgpt/admin/captures/inspect` | Validate a request capture |
| `POST` | `/v1/chatgpt/admin/captures/save` | Encrypt and save a capture |
| `POST` | `/v1/chatgpt/admin/accounts/check` | Check account configuration |
| `POST` | `/v1/chatgpt/admin/accounts/delete` | Delete an account capture |
| `GET` | `/v1/chatgpt/admin/artifacts` | List generated artifacts |
| `GET` | `/v1/chatgpt/files/{id}/{filename}` | Download an artifact |
| `GET` | `/admin` | Redirect to the Bridge Console |

The admin API also provides settings, chat/image test routes, and OpenCode
injection/ejection routes. The complete implementation is in
`src/server.ts`.

## Environment configuration

Copy `.env.example` to `.env` and adjust the values for the deployment:

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` in a container or reverse-proxy setup |
| `PORT` | `8000` | HTTP port |
| `CHATGPT_API_KEY` | `local-dev-key` | Bearer key for this bridge; change it |
| `CHATGPT_ACCOUNTS_DIR` | `./secrets/accounts` | Account capture directory |
| `CHATGPT_ACCOUNT` | empty | Default account |
| `CHATGPT_ACCOUNTS` | empty | Comma-separated account pool |
| `CHATGPT_ACCOUNT_STRATEGY` | `auto` | Account routing strategy |
| `CHATGPT_PUBLIC_BASE_URL` | `http://127.0.0.1:8000/v1` | Public API base used in artifact URLs |
| `CHATGPT_SECRETS_PASSPHRASE` | empty | Optional passphrase for secret handling |
| `CHATGPT_BASE_URL` | `https://chatgpt.com` | ChatGPT Web base URL |
| `CHATGPT_WEB_TIMEOUT` | `180000` | Upstream request timeout in milliseconds |
| `CHATGPT_REFRESH_WEB_TOKENS` | `true` | Refresh browser-derived web tokens |
| `CHATGPT_ADMIN_DB_PATH` | `./outputs/chatgpt-admin.sqlite` | SQLite metadata database |
| `CHATGPT_IMAGE_OUTPUT_DIR` | `./outputs/chatgpt-images` | Image output directory |
| `CHATGPT_RESEARCH_OUTPUT_DIR` | `./outputs/chatgpt-research` | Research report directory |

For a shared host, bind to the host-provided port and set:

```dotenv
HOST=0.0.0.0
PORT=8000
CHATGPT_PUBLIC_BASE_URL=https://api.example.com/v1
```

Place the service behind HTTPS and a reverse proxy in production. Do not
expose the admin routes directly to the public internet without an additional
access-control layer.

## Docker

The repository includes a production-oriented `Dockerfile` and
`docker-compose.yml`. The image builds the TypeScript server, removes
development dependencies, exposes port `8000`, and starts `dist/index.js`.

### Docker Compose

```sh
cp .env.example .env
# Set a strong CHATGPT_API_KEY in .env.

docker compose up --build -d
docker compose logs -f bridge-api
```

The compose service maps `${PORT:-8000}` on the host to port `8000` in the
container and persists:

- `./secrets` for encrypted account captures and the master key.
- `./outputs` for images, research reports, and the SQLite admin database.

Check the container:

```sh
curl http://127.0.0.1:8000/health \\
  -H "Authorization: Bearer $CHATGPT_API_KEY"
```

Stop it with:

```sh
docker compose down
```

### Build and run manually

```sh
docker build -t gpt-api-node:local .
docker run --rm \\
  --name gpt-api-node \\
  --env-file .env \\
  -p 8000:8000 \\
  -v "$PWD/secrets:/app/secrets" \\
  -v "$PWD/outputs:/app/outputs" \\
  gpt-api-node:local
```

The Docker image intentionally does not copy `reference/`, `secrets/`, or
`outputs/` into the image.

## Bridge Console and CLI

The optional Svelte console is a separate development server:

```sh
npm run build:console
npm --prefix apps/bridge-console run dev -- --host 0.0.0.0
```

Open `http://127.0.0.1:5174`, set the API base URL to the bridge URL ending in
`/v1`, and use the same bearer key as the API.

CLI examples:

```sh
npm run build
node dist/cli.js doctor
node dist/cli.js server
node dist/cli.js admin accounts
node dist/cli.js api chat --prompt 'Say hello' --model chatgpt-web/auto
node dist/cli.js secrets check
```

## Development and verification

```sh
npm install
npm test                 # TypeScript build + Node test suite
npm run build            # Build the API and CLI
npm run build:console    # Build the optional console
npm run build:all        # Build both
```

The local `reference/` directory is a shallow clone used for behavior
comparison and is not included in the Docker image or the root Git history.

## Security notes

- Treat copied browser requests as passwords: they can contain cookies,
  authorization tokens, and browser-specific proof material.
- Use a unique, strong `CHATGPT_API_KEY` and rotate it if it is exposed.
- Keep `secrets/`, `.env`, and `outputs/` out of Git. The default `.gitignore`
  and `.dockerignore` already exclude them.
- Use only accounts and infrastructure for which you have permission.
- The bridge does not provide live ChatGPT quota probing; usage endpoints report
  capture-derived capabilities.

## License and upstream

This repository is an independent Node.js rewrite for the local project. The
original reference project is available at
[`suphotP/chatgpt-api`](https://github.com/suphotP/chatgpt-api). Review the
upstream license and this repository's dependency licenses before redistributing.
