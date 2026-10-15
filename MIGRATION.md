# Migration notes

`reference/` is the original Python project. The new implementation removes
`apps/character-game` and keeps the Bridge Console as a separate Svelte static
app.

## Port order

1. Core provider types and error mapping.
2. Account capture parser, HAR import, and `enc:v1:` Fernet compatibility.
3. Filesystem artifacts and SQLite admin store.
4. ChatGPT Web transport, token/proof refresh, and SSE normalization.
5. Account routing, limits, failover, and operation cancellation.
6. Public API routes: chat, image, vision, files, usage, operations.
7. Admin routes used by the console.
8. CLI commands and deployment packaging.

## Deliberate first milestone

The first Node milestone is intentionally small and independently testable:

- native Node HTTP server;
- bearer authentication and CORS;
- `/health`, `/v1/models`, and basic admin status/settings;
- JSON/SSE chat response facade;
- environment and plaintext copied-request auth loading;
- root project build/test scripts;
- console build kept separate from API build.

The provider transport still needs compatibility work before it should be
treated as production-ready. In particular, the Python reference uses browser-
shaped HTTP behavior, sentinel/proof refresh, multiple account routing, image
uploads, and Deep Research flows that cannot safely be assumed to work with a
single generic `fetch` call.
