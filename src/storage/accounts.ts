import fs from "node:fs";
import path from "node:path";
import {
  decryptText,
  encryptText,
  encryptOrReencryptFile,
  isEncrypted,
  loadSecretsKey,
  type EncryptFileResult,
} from "../security/crypto.js";

export const DEFAULT_ACCOUNTS_DIR = path.join("secrets", "accounts");
export const DEFAULT_CAPTURE_NAME = "chatgpt-request.txt";
export const DEFAULT_SETTINGS_NAME = "settings.json";
export const ACCOUNT_NAME_RULE =
  "account names may only contain English letters, numbers, underscore, and dash";

const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class ChatGPTAccountProfile {
  public constructor(
    public readonly name: string,
    public readonly capturePath: string,
  ) {}

  public get exists(): boolean {
    return fs.existsSync(this.capturePath);
  }

  public get settingsPath(): string {
    return path.join(path.dirname(this.capturePath), DEFAULT_SETTINGS_NAME);
  }

  public get hasSettings(): boolean {
    return fs.existsSync(this.settingsPath);
  }
}

export function accountsDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHATGPT_ACCOUNTS_DIR?.trim() || DEFAULT_ACCOUNTS_DIR;
}

function expandHome(value: string): string {
  return value === "~" ? process.env.HOME ?? value : value.startsWith("~/")
    ? path.join(process.env.HOME ?? "~", value.slice(2))
    : value;
}

function validateAccountName(account: string): void {
  if (!ACCOUNT_PATTERN.test(account)) throw new Error(ACCOUNT_NAME_RULE);
}

export function resolveAccountCapturePath(account: string, accountsDir = accountsDirFromEnv()): string {
  validateAccountName(account);
  return path.join(expandHome(accountsDir), account, DEFAULT_CAPTURE_NAME);
}

export function resolveAccountSettingsPath(account: string, accountsDir = accountsDirFromEnv()): string {
  validateAccountName(account);
  return path.join(expandHome(accountsDir), account, DEFAULT_SETTINGS_NAME);
}

export function listAccountProfiles(accountsDir = accountsDirFromEnv()): ChatGPTAccountProfile[] {
  const root = expandHome(accountsDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ACCOUNT_PATTERN.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => new ChatGPTAccountProfile(entry.name, path.join(root, entry.name, DEFAULT_CAPTURE_NAME)));
}

/** Read either a legacy plaintext capture or an enc:v1 capture. */
export function readCaptureFile(pathname: string, key?: Buffer | string): string {
  const text = fs.readFileSync(pathname, "utf8");
  return isEncrypted(text) ? decryptText(text, key ?? loadSecretsKey(path.dirname(path.dirname(pathname)))) : text;
}

export function writeCaptureFile(pathname: string, text: string, key?: Buffer | string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pathname, key ? encryptText(text, key) : text, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(pathname, 0o600);
}

export function loadAccountCapture(account: string, accountsDir = accountsDirFromEnv()): string {
  return readCaptureFile(resolveAccountCapturePath(account, accountsDir));
}

export function saveAccountCapture(
  account: string,
  text: string,
  accountsDir = accountsDirFromEnv(),
  key?: Buffer | string,
): string {
  const pathname = resolveAccountCapturePath(account, accountsDir);
  writeCaptureFile(pathname, text, key);
  return pathname;
}

export function encryptAccountCapture(
  account: string,
  accountsDir = accountsDirFromEnv(),
  key = loadSecretsKey(accountsDir),
): EncryptFileResult {
  const pathname = resolveAccountCapturePath(account, accountsDir);
  if (!fs.existsSync(pathname)) return null;
  return encryptOrReencryptFile(pathname, key, key);
}

