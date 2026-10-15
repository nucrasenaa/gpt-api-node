import path from "node:path";

export interface BridgeConfig {
  nodeEnv: string;
  host: string;
  port: number;
  apiKey: string | undefined;
  accountsDir: string;
  account: string | undefined;
  accounts: string[];
  accountStrategy: string;
  modelFallback: string | undefined;
  temporaryChat: boolean;
  agentPromptMode: string;
  publicBaseUrl: string;
  requestPath: string | undefined;
  accessToken: string | undefined;
  proofToken: string | undefined;
  turnstileToken: string | undefined;
  cookiesJson: string;
  headersJson: string;
  chatgptBaseUrl: string;
  webTimeoutMs: number;
  refreshWebTokens: boolean;
  userAgent: string;
  maxBodyBytes: number;
  imageOutputDir: string;
  researchOutputDir: string;
  adminDbPath: string;
  consoleUrl: string;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    host: env.HOST ?? env.CHATGPT_API_HOST ?? "127.0.0.1",
    port: integer(env.PORT ?? env.CHATGPT_API_PORT, 8000),
    apiKey: optional(env.CHATGPT_API_KEY),
    accountsDir: path.resolve(env.CHATGPT_ACCOUNTS_DIR ?? "./secrets/accounts"),
    account: optional(env.CHATGPT_ACCOUNT),
    accounts: csv(env.CHATGPT_ACCOUNTS),
    accountStrategy: env.CHATGPT_ACCOUNT_STRATEGY ?? "auto",
    modelFallback: optional(env.CHATGPT_MODEL_FALLBACK) ?? "auto",
    temporaryChat: boolean(env.CHATGPT_TEMPORARY_CHAT, true),
    agentPromptMode: env.CHATGPT_AGENT_MODE ?? "optimized",
    publicBaseUrl: env.CHATGPT_PUBLIC_BASE_URL ?? "http://127.0.0.1:8000/v1",
    requestPath: optional(env.CHATGPT_REQUEST_PATH),
    accessToken: optional(env.CHATGPT_ACCESS_TOKEN),
    proofToken: optional(env.CHATGPT_PROOF_TOKEN),
    turnstileToken: optional(env.CHATGPT_TURNSTILE_TOKEN),
    cookiesJson: env.CHATGPT_COOKIES_JSON ?? "{}",
    headersJson: env.CHATGPT_HEADERS_JSON ?? "{}",
    chatgptBaseUrl: env.CHATGPT_BASE_URL ?? "https://chatgpt.com",
    webTimeoutMs: integer(env.CHATGPT_WEB_TIMEOUT, 180_000),
    refreshWebTokens: boolean(env.CHATGPT_REFRESH_WEB_TOKENS, true),
    userAgent: env.CHATGPT_USER_AGENT ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15",
    maxBodyBytes: integer(env.CHATGPT_MAX_BODY_BYTES, 10 * 1024 * 1024),
    imageOutputDir: path.resolve(env.CHATGPT_IMAGE_OUTPUT_DIR ?? "./outputs/chatgpt-images"),
    researchOutputDir: path.resolve(env.CHATGPT_RESEARCH_OUTPUT_DIR ?? "./outputs/chatgpt-research"),
    adminDbPath: path.resolve(env.CHATGPT_ADMIN_DB_PATH ?? "./outputs/chatgpt-admin.sqlite"),
    consoleUrl: env.CHATGPT_CONSOLE_URL ?? "http://127.0.0.1:5174",
  };
}
