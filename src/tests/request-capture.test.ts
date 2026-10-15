import assert from "node:assert/strict";
import test from "node:test";
import { parseCapture } from "../auth/request-capture.js";

test("parseCapture reads copied cURL headers, cookies, and JSON payload", () => {
  const capture = parseCapture(`curl 'https://chatgpt.com/backend-api/f/conversation' \\
    -H 'Authorization: Bearer token-123' \\
    -H 'Cookie: __Secure-next-auth.session-token=session' \\
    -H 'Content-Type: application/json' \\
    --data-raw '{"action":"next","model":"auto"}'`);

  assert.equal(capture.url, "https://chatgpt.com/backend-api/f/conversation");
  assert.equal(capture.headers.authorization, "Bearer token-123");
  assert.equal(capture.cookies["__Secure-next-auth.session-token"], "session");
  assert.deepEqual(capture.requestJson, { action: "next", model: "auto" });
});

test("parseCapture accepts the simple request summary format", () => {
  const capture = parseCapture(`URL: https://chatgpt.com/backend-api/f/conversation
Authorization: Bearer token-456
Cookie: foo=bar; baz=qux
Request Data: {"action":"next"}`);

  assert.equal(capture.url, "https://chatgpt.com/backend-api/f/conversation");
  assert.equal(capture.headers.authorization, "Bearer token-456");
  assert.deepEqual(capture.cookies, { foo: "bar", baz: "qux" });
  assert.deepEqual(capture.requestJson, { action: "next" });
});
