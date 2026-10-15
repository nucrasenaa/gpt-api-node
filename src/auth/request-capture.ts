import path from "node:path";
import type { BridgeConfig } from "../config.js";
import { ProviderNotConfiguredError } from "../errors.js";
import { readCaptureFile } from "../storage/accounts.js";

export interface Capture {
  url?: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  requestJson?: Record<string, unknown>;
}

export interface AuthConfig {
  accessToken?: string;
  proofToken?: string;
  turnstileToken?: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  capturedUrl?: string;
  capturedRequestJson?: Record<string, unknown>;
  source: string;
}

const replayableHeaders = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cache-control",
  "chatgpt-account-id",
  "content-type",
  "cookie",
  "oai-client-build-number",
  "oai-client-version",
  "oai-did",
  "oai-device-id",
  "oai-echo-logs",
  "oai-language",
  "oai-session-id",
  "oai-telemetry",
  "openai-sentinel-arkose-token",
  "openai-sentinel-chat-requirements-token",
  "openai-sentinel-proof-token",
  "openai-sentinel-turnstile-token",
  "origin",
  "originator",
  "priority",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "x-conduit-token",
  "x-oai-mcp-form-version",
  "x-oai-turn-trace-id",
  "x-openai-sentinel-prepare-p",
  "x-openai-codex-window-type",
  "x-openai-web-frontend",
  "x-openai-web-sse-compression",
  "x-openai-target-path",
  "x-openai-target-route",
]);

function parseCookieHeader(value: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (name) cookies[name] = cookieValue.replace(/^"|"$/g, "");
  }
  return cookies;
}

function findJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, index + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function shellTokens(text: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (): void => {
    if (token) tokens.push(token);
    token = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === undefined) continue;
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && typeof next === "string" && ["\\", '"', "$", "`"].includes(next)) {
        token += next;
        index += 1;
      } else token += char;
      continue;
    }
    if (char === "\\") {
      if (next === "\n" || next === "\r") {
        index += next === "\r" && text[index + 2] === "\n" ? 2 : 1;
      } else escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    token += char;
  }
  if (escaped) token += "\\";
  push();
  return tokens;
}

function parseCurl(text: string): Partial<Capture> {
  const tokens = shellTokens(text);
  const curlIndex = tokens.findIndex((token) => token.toLowerCase() === "curl");
  if (curlIndex < 0) return {};
  const headers: Record<string, string> = {};
  let url: string | undefined;
  let requestJson: Record<string, unknown> | undefined;
  for (let index = curlIndex + 1; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (!option) continue;
    const value = tokens[index + 1];
    if ((option === "-H" || option === "--header") && value !== undefined) {
      index += 1;
      const raw = value;
      if (!raw) continue;
      const separator = raw.indexOf(":");
      if (separator <= 0) continue;
      const name = raw.slice(0, separator).trim().toLowerCase();
      if (!replayableHeaders.has(name)) continue;
      headers[name] = raw.slice(separator + 1).trim();
      continue;
    }
    if ((option === "-b" || option === "--cookie") && value !== undefined) {
      index += 1;
      headers.cookie = value;
      continue;
    }
    if (["-d", "--data", "--data-raw", "--data-binary"].includes(option) && value !== undefined) {
      index += 1;
      requestJson = findJsonObject(value);
      continue;
    }
    if ((option === "--url" || option === "-u") && value !== undefined) {
      index += 1;
      url = value;
      continue;
    }
    if (!option.startsWith("-") && /^https?:\/\//i.test(option) && !url) url = option;
  }
  return { url, headers, requestJson };
}

export function parseCapture(text: string): Capture {
  const parsedCurl = /(^|\n)\s*\$?\s*curl(?:\s|$)/i.test(text) ? parseCurl(text) : {};
  const headers: Record<string, string> = { ...(parsedCurl.headers ?? {}) };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*:\s*(.+?)\s*$/);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].toLowerCase();
    if (replayableHeaders.has(name)) headers[name] = match[2];
  }
  const cookieHeader = headers.cookie;
  const requestJson = parsedCurl.requestJson ?? findJsonObject(text);
  return {
    url: text.match(/^\s*(?:URL|Request URL):\s*(\S+)/im)?.[1] ?? parsedCurl.url,
    headers,
    cookies: cookieHeader ? parseCookieHeader(cookieHeader) : {},
    requestJson,
  };
}

function jsonObject(value: string, name: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${name} must be a JSON object`);
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
  } catch (error) {
    throw new ProviderNotConfiguredError(error instanceof Error ? error.message : `${name} is invalid`);
  }
}

export async function loadAuth(config: BridgeConfig): Promise<AuthConfig> {
  let capture: Capture | undefined;
  let source = "env";
  const requestPath = config.requestPath
    ? path.resolve(config.requestPath)
    : config.account
      ? path.join(config.accountsDir, config.account, "chatgpt-request.txt")
      : undefined;
  if (requestPath) {
    try {
      capture = parseCapture(readCaptureFile(requestPath, undefined));
      source = requestPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const headers = {
    ...(capture?.headers ?? {}),
    ...jsonObject(config.headersJson, "CHATGPT_HEADERS_JSON"),
  };
  const cookies = {
    ...(capture?.cookies ?? {}),
    ...jsonObject(config.cookiesJson, "CHATGPT_COOKIES_JSON"),
  };
  const authorization = headers.authorization;
  const accessToken = config.accessToken
    ?? (authorization?.includes(" ") ? authorization.split(" ", 2)[1] : authorization);
  const cookieHeader = headers.cookie ?? Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ");
  if (cookieHeader) headers.cookie = cookieHeader;
  if (accessToken && !headers.authorization) headers.authorization = `Bearer ${accessToken}`;

  return {
    accessToken,
    proofToken: config.proofToken ?? headers["openai-sentinel-proof-token"],
    turnstileToken: config.turnstileToken ?? headers["openai-sentinel-turnstile-token"],
    headers,
    cookies,
    capturedUrl: capture?.url,
    capturedRequestJson: capture?.requestJson,
    source,
  };
}
