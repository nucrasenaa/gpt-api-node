import path from "node:path";

export interface BridgeConfig {
  nodeEnv: string;
  host: string;
  port: number;
  apiKey: string | undefined;
  accountsDir: string;
  account: string | undefined;
  publicBaseUrl: string;
  requestPath: string | undefined;
  accessToken: string | undefined;
  proofToken: string | undefined;
  turnstileToken: string | undefined;
  cookiesJson: string;
  headersJson: string;
  chatgptBaseUrl: string;
  webTimeoutMs: number;
  maxBodyBytes: number;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    host: env.HOST ?? env.CHATGPT_API_HOST ?? "127.0.0.1",
    port: integer(env.PORT ?? env.CHATGPT_API_PORT, 8000),
    apiKey: optional(env.CHATGPT_API_KEY),
    accountsDir: path.resolve(env.CHATGPT_ACCOUNTS_DIR ?? "./secrets/accounts"),
    account: optional(env.CHATGPT_ACCOUNT),
    publicBaseUrl: env.CHATGPT_PUBLIC_BASE_URL ?? "http://127.0.0.1:8000/v1",
    requestPath: optional(env.CHATGPT_REQUEST_PATH),
    accessToken: optional(env.CHATGPT_ACCESS_TOKEN),
    proofToken: optional(env.CHATGPT_PROOF_TOKEN),
    turnstileToken: optional(env.CHATGPT_TURNSTILE_TOKEN),
    cookiesJson: env.CHATGPT_COOKIES_JSON ?? "{}",
    headersJson: env.CHATGPT_HEADERS_JSON ?? "{}",
    chatgptBaseUrl: env.CHATGPT_BASE_URL ?? "https://chatgpt.com",
    webTimeoutMs: integer(env.CHATGPT_WEB_TIMEOUT, 180_000),
    maxBodyBytes: integer(env.CHATGPT_MAX_BODY_BYTES, 10 * 1024 * 1024),
  };
}
