import fs from "node:fs";
import path from "node:path";
import type { Capture } from "../auth/request-capture.js";
import { parseCapture } from "../auth/request-capture.js";
import { readCaptureFile } from "../storage/accounts.js";

export const DEFAULT_ACCOUNTS_DIR = "secrets/accounts";
export const DEFAULT_CAPTURE_NAME = "chatgpt-request.txt";
export const DEFAULT_SETTINGS_NAME = "settings.json";
export const ACCOUNT_NAME_RULE = "account names may only contain English letters, numbers, underscore, and dash";

const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface AccountProfile {
  readonly name: string;
  readonly capturePath: string;
  readonly settingsPath: string;
  readonly exists: boolean;
  readonly hasSettings: boolean;
}

export interface AccountDiscoveryOptions {
  readonly accountsDir?: string;
  readonly accounts?: readonly string[];
  readonly includeInvalidCaptures?: boolean;
}

export interface AccountInfo {
  planType?: string;
  planBucket?: "free" | "paid";
  email?: string;
  accountId?: string;
  userId?: string;
  tokenExpiresAt?: string;
  observedModels: string[];
  observedEfforts: string[];
  observedActions: string[];
  lastModelConfig: Record<string, unknown>;
  defaultModelConfig: Record<string, unknown>;
  requestModel?: string;
  requestThinkingEffort?: string;
  requestAction?: string;
  settingsDefaultModelSlug?: string;
  settingsDefaultJuices: Record<string, string>;
  settingsLastUsedSlugs: Record<string, string>;
  settingsLastUsedJuices: Record<string, Record<string, string>>;
  settingsAvailableReasoningEfforts: string[];
  settingsWingmanThinkingEffort?: string;
  toRedactedDict(): Record<string, unknown>;
}

export interface AccountCapabilities {
  planType?: string;
  planBucket?: "free" | "paid";
  supportedModels: string[];
  defaultModel?: string;
  thinkingModel?: string;
  thinkingEfforts: string[];
  proModel?: string;
  proEfforts: string[];
  backendReasoningEfforts: string[];
  autoModel: "auto";
  autoOnly: boolean;
  autoOnlyReason?: string;
  extraObservedModels: string[];
  scope: string;
}

export interface DiscoveredAccount extends AccountProfile {
  readonly capture?: Capture;
  readonly settings: Record<string, unknown>;
  readonly info?: AccountInfo;
  readonly capabilities?: AccountCapabilities;
  readonly error?: string;
}

const CORE_MODEL = "gpt-5-5";
const THINKING_MODEL = "gpt-5-5-thinking";
const PRO_MODEL = "gpt-5-5-pro";
const AUTO_ONLY_PLANS = new Set(["free", "go"]);
const EXPLICIT_CORE_PLANS = new Set(["plus", "pro", "team", "enterprise", "edu"]);
const THINKING_PLANS = new Set(["plus", "pro", "team", "enterprise", "edu"]);
const PRO_PLANS = new Set(["pro"]);
const DEFAULT_PRO_EFFORTS = ["standard", "extended"];
const DEFAULT_THINKING_EFFORTS = ["standard", "extended", "max"];

export function accountsDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.CHATGPT_ACCOUNTS_DIR?.trim();
  return value ? expandHome(value) : DEFAULT_ACCOUNTS_DIR;
}

export function validateAccountName(account: string): string {
  if (!ACCOUNT_NAME_PATTERN.test(account)) throw new Error(ACCOUNT_NAME_RULE);
  return account;
}

export function resolveAccountCapturePath(account: string, accountsDir = accountsDirFromEnv()): string {
  validateAccountName(account);
  return path.join(expandHome(accountsDir), account, DEFAULT_CAPTURE_NAME);
}

export function resolveAccountSettingsPath(account: string, accountsDir = accountsDirFromEnv()): string {
  validateAccountName(account);
  return path.join(expandHome(accountsDir), account, DEFAULT_SETTINGS_NAME);
}

export function listAccountProfiles(accountsDir = accountsDirFromEnv()): AccountProfile[] {
  const root = expandHome(accountsDir);
  if (!fs.existsSync(root)) return [];
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return children
    .filter((child) => child.isDirectory() && ACCOUNT_NAME_PATTERN.test(child.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child) => {
      const capturePath = resolveAccountCapturePath(child.name, root);
      const settingsPath = resolveAccountSettingsPath(child.name, root);
      return {
        name: child.name,
        capturePath,
        settingsPath,
        exists: fs.existsSync(capturePath),
        hasSettings: fs.existsSync(settingsPath),
      };
    });
}

export const listAccounts = listAccountProfiles;
export const discoverAccountProfiles = listAccountProfiles;

/** Discover saved profiles and derive non-secret capability hints from captures. */
export function discoverAccounts(options: AccountDiscoveryOptions = {}): DiscoveredAccount[] {
  const root = options.accountsDir ?? accountsDirFromEnv();
  const names = options.accounts?.length
    ? [...new Set(options.accounts.map((account) => account.trim()).filter(Boolean))]
    : listAccountProfiles(root).map((profile) => profile.name);
  const profiles = names.map((name) => profileFor(name, root));
  return profiles.map((profile) => discoverProfile(profile, options.includeInvalidCaptures === true));
}

export function readAccountSettings(settingsPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const loadSettingsFile = readAccountSettings;

export function decodeAuthorizationClaims(authorization?: string): Record<string, unknown> {
  if (!authorization) return {};
  const token = authorization.includes(" ") ? authorization.split(" ", 2)[1] : authorization;
  if (!token) return {};
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const decoded = Buffer.from(`${part}${"=".repeat((4 - part.length % 4) % 4)}`, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseJsonCookie(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function detectAccountInfo(capture: Pick<Capture, "headers" | "cookies" | "requestJson">, settings?: Record<string, unknown>): AccountInfo {
  const info: AccountInfo = {
    observedModels: [],
    observedEfforts: [],
    observedActions: [],
    lastModelConfig: parseJsonCookie(capture.cookies?.["oai-last-model-config"]),
    defaultModelConfig: parseJsonCookie(capture.cookies?.["oai-default-model-config"]),
    settingsDefaultJuices: {},
    settingsLastUsedSlugs: {},
    settingsLastUsedJuices: {},
    settingsAvailableReasoningEfforts: [],
    toRedactedDict: () => ({}),
  };
  const claims = decodeAuthorizationClaims(capture.headers?.authorization);
  const authClaims = objectValue(claims, "https://api.openai.com/auth");
  const profileClaims = objectValue(claims, "https://api.openai.com/profile");
  info.planType = stringValue(authClaims?.chatgpt_plan_type);
  info.accountId = stringValue(authClaims?.chatgpt_account_id);
  info.userId = stringValue(authClaims?.chatgpt_user_id) ?? stringValue(authClaims?.user_id);
  info.email = stringValue(profileClaims?.email);
  const exp = claims.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) info.tokenExpiresAt = new Date(exp * 1000).toISOString();
  info.planBucket = planBucket(info.planType);

  const request = capture.requestJson ?? {};
  info.requestModel = stringValue(request.model);
  info.requestThinkingEffort = stringValue(request.thinking_effort);
  info.requestAction = stringValue(request.action);
  appendUnique(info.observedModels, info.requestModel);
  appendUnique(info.observedModels, stringValue(info.lastModelConfig.model));
  appendUnique(info.observedModels, stringValue(info.defaultModelConfig.model));
  appendUnique(info.observedEfforts, info.requestThinkingEffort);
  appendUnique(info.observedEfforts, stringValue(info.lastModelConfig.effort));
  const juices = objectValue(info.defaultModelConfig, "juices");
  for (const value of Object.values(juices ?? {})) appendUnique(info.observedEfforts, stringValue(value));
  appendUnique(info.observedActions, info.requestAction);
  if (settings) applySettingsInfo(info, settings);
  info.toRedactedDict = () => ({
    plan_type: info.planType,
    plan_bucket: info.planBucket,
    email: maskEmail(info.email),
    account_id: maskId(info.accountId),
    user_id: maskId(info.userId),
    token_expires_at: info.tokenExpiresAt,
    observed_models: info.observedModels,
    observed_efforts: info.observedEfforts,
    observed_actions: info.observedActions,
    last_model_config: info.lastModelConfig,
    default_model_config: info.defaultModelConfig,
    request_model: info.requestModel,
    request_thinking_effort: info.requestThinkingEffort,
    request_action: info.requestAction,
    settings_default_model_slug: info.settingsDefaultModelSlug,
    settings_default_juices: info.settingsDefaultJuices,
    settings_last_used_slugs: info.settingsLastUsedSlugs,
    settings_last_used_juices: info.settingsLastUsedJuices,
    settings_available_reasoning_efforts: info.settingsAvailableReasoningEfforts,
    settings_wingman_thinking_effort: info.settingsWingmanThinkingEffort,
    scope: "capture-derived; not an exhaustive live capability matrix",
  });
  return info;
}

export function applySettingsInfo(info: AccountInfo, settingsBlob: Record<string, unknown>): void {
  const settings = objectValue(settingsBlob, "settings");
  const defaults = objectValue(settings, "default_model_config");
  info.settingsDefaultModelSlug = stringValue(defaults?.default_model_slug);
  const defaultJuices = objectValue(defaults, "juices");
  info.settingsDefaultJuices = stringRecord(defaultJuices);

  const lastUsed = objectValue(settings, "last_used_model_config");
  info.settingsLastUsedSlugs = stringRecord(objectValue(lastUsed, "slugs"));
  const lastUsedJuices = objectValue(lastUsed, "juices");
  info.settingsLastUsedJuices = nestedStringRecord(lastUsedJuices);
  info.settingsWingmanThinkingEffort = stringValue(settings?.wingman_thinking_effort);
  const available = objectValue(settingsBlob, "available_options");
  const efforts = available?.backend_reasoning_effort;
  info.settingsAvailableReasoningEfforts = Array.isArray(efforts) ? efforts.filter((item): item is string => typeof item === "string") : [];

  appendUnique(info.observedModels, info.settingsDefaultModelSlug);
  for (const model of Object.values(info.settingsLastUsedSlugs)) appendUnique(info.observedModels, model);
  for (const platform of Object.values(info.settingsLastUsedJuices)) {
    for (const model of Object.keys(platform)) appendUnique(info.observedModels, model);
    for (const effort of Object.values(platform)) appendUnique(info.observedEfforts, effort);
  }
  for (const effort of Object.values(info.settingsDefaultJuices)) appendUnique(info.observedEfforts, effort);
  for (const effort of info.settingsAvailableReasoningEfforts) appendUnique(info.observedEfforts, effort);
  appendUnique(info.observedEfforts, info.settingsWingmanThinkingEffort);
}

export function inferAccountCapabilities(info: AccountInfo): AccountCapabilities {
  const supportedModels: string[] = [];
  const planType = info.planType?.toLowerCase() ?? "";
  const observed = new Set(info.observedModels);
  if (EXPLICIT_CORE_PLANS.has(planType) || (!planType && observed.has(CORE_MODEL))) appendUnique(supportedModels, CORE_MODEL);
  if (allowsThinking(info)) appendUnique(supportedModels, THINKING_MODEL);
  const autoOnly = AUTO_ONLY_PLANS.has(planType);
  if (observed.has(CORE_MODEL) && !AUTO_ONLY_PLANS.has(planType)) appendUnique(supportedModels, CORE_MODEL);
  if (observed.has(THINKING_MODEL) && allowsThinking(info)) appendUnique(supportedModels, THINKING_MODEL);
  if (allowsPro(info)) appendUnique(supportedModels, PRO_MODEL);
  const autoOnlyReason = autoOnly
    ? "free/go captures are exposed as ChatGPT Web Auto only; explicit model slugs can be limited, downgraded, or return empty assistant text in the web flow"
    : undefined;
  return {
    planType: info.planType,
    planBucket: info.planBucket,
    supportedModels,
    defaultModel: defaultSupportedModel(info, supportedModels),
    thinkingModel: supportedModels.includes(THINKING_MODEL) ? THINKING_MODEL : undefined,
    thinkingEfforts: supportedModels.includes(THINKING_MODEL) ? modelEfforts(info, THINKING_MODEL, DEFAULT_THINKING_EFFORTS) : [],
    proModel: supportedModels.includes(PRO_MODEL) ? PRO_MODEL : undefined,
    proEfforts: supportedModels.includes(PRO_MODEL) ? modelEfforts(info, PRO_MODEL, DEFAULT_PRO_EFFORTS) : [],
    backendReasoningEfforts: [...info.settingsAvailableReasoningEfforts],
    autoModel: "auto",
    autoOnly,
    autoOnlyReason,
    extraObservedModels: info.observedModels.filter((model) => !supportedModels.includes(model) && model !== "auto"),
    scope: "inferred from capture/settings/plan; confirm with a live chat test when tokens change",
  };
}

export function planBucket(planType?: string): "free" | "paid" | undefined {
  if (!planType) return undefined;
  return planType.toLowerCase() === "free" ? "free" : "paid";
}

export function maskEmail(email?: string): string | undefined {
  if (!email || !email.includes("@")) return email;
  const [name, domain] = email.split("@", 2);
  if (!name || !domain) return email;
  return name.length <= 2 ? `${name.slice(0, 1)}***@${domain}` : `${name[0]}***${name.at(-1)}@${domain}`;
}

export function maskId(value?: string): string | undefined {
  if (!value) return value;
  return value.length <= 10 ? "***" : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function profileFor(name: string, accountsDir: string): AccountProfile {
  validateAccountName(name);
  const capturePath = resolveAccountCapturePath(name, accountsDir);
  const settingsPath = resolveAccountSettingsPath(name, accountsDir);
  return { name, capturePath, settingsPath, exists: fs.existsSync(capturePath), hasSettings: fs.existsSync(settingsPath) };
}

function discoverProfile(profile: AccountProfile, includeInvalidCaptures: boolean): DiscoveredAccount {
  if (!profile.exists) return { ...profile, settings: {} };
  try {
    const capture = parseCapture(readCaptureFile(profile.capturePath));
    const settings = profile.hasSettings ? readAccountSettings(profile.settingsPath) : {};
    const info = detectAccountInfo(capture, settings);
    return { ...profile, capture, settings, info, capabilities: inferAccountCapabilities(info) };
  } catch (error) {
    if (!includeInvalidCaptures) return { ...profile, settings: {}, error: error instanceof Error ? error.message : String(error) };
    return { ...profile, settings: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function expandHome(value: string): string {
  return value === "~" ? process.env.HOME ?? value : value.startsWith("~/") ? path.join(process.env.HOME ?? "~", value.slice(2)) : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const candidate = value?.[key];
  return isObject(candidate) ? candidate : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function appendUnique(values: string[], value?: string): void {
  if (value && !values.includes(value)) values.push(value);
}

function stringRecord(value?: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => typeof item === "string")) as Record<string, string>;
}

function nestedStringRecord(value?: Record<string, unknown>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(value ?? {}).flatMap(([key, item]) => isObject(item) ? [[key, stringRecord(item)]] : []));
}

function allowsThinking(info: AccountInfo): boolean {
  const plan = info.planType?.toLowerCase() ?? "";
  return THINKING_PLANS.has(plan) || (!AUTO_ONLY_PLANS.has(plan) && info.observedModels.includes(THINKING_MODEL));
}

function allowsPro(info: AccountInfo): boolean {
  const plan = info.planType?.toLowerCase() ?? "";
  return PRO_PLANS.has(plan) || (!new Set(["free", "go", "plus"]).has(plan) && info.observedModels.includes(PRO_MODEL));
}

function defaultSupportedModel(info: AccountInfo, supported: string[]): string | undefined {
  const preferred = [info.settingsLastUsedSlugs.web, info.settingsLastUsedSlugs.default, info.requestModel, stringValue(info.lastModelConfig.model)];
  return preferred.find((model) => model !== undefined && supported.includes(model)) ?? supported[0];
}

function modelEfforts(info: AccountInfo, model: string, defaults: readonly string[]): string[] {
  const result = [...defaults];
  if (info.requestModel === model) appendUnique(result, info.requestThinkingEffort);
  if (info.lastModelConfig.model === model) appendUnique(result, stringValue(info.lastModelConfig.effort));
  for (const platform of Object.values(info.settingsLastUsedJuices)) appendUnique(result, platform[model]);
  return result;
}
