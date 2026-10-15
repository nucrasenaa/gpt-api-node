#!/usr/bin/env node
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createBridgeServer } from "./server.js";
import { discoverAccounts } from "./routing/accounts.js";
import { encryptOrReencryptFile, loadSecretsKey } from "./security/crypto.js";
import { listAccountProfiles, readCaptureFile } from "./storage/accounts.js";

type Args = { _: string[]; [key: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) { args._.push(value); continue; }
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) args[key!] = inline;
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) args[key!] = argv[++index]!;
    else args[key!] = true;
  }
  return args;
}

function stringArg(args: Args, key: string, fallback?: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function json(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }

async function apiRequest(args: Args, pathname: string, init: RequestInit = {}): Promise<unknown> {
  const config = loadConfig();
  const baseUrl = (stringArg(args, "base-url", config.publicBaseUrl) ?? config.publicBaseUrl).replace(/\/$/, "");
  const apiKey = stringArg(args, "api-key", config.apiKey);
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 1000)}`);
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

async function commandDoctor(): Promise<void> {
  const config = loadConfig();
  const accounts = discoverAccounts({ accountsDir: config.accountsDir, accounts: config.accounts.length ? config.accounts : undefined, includeInvalidCaptures: true });
  json({ node: process.version, node_sqlite: process.versions.modules, host: config.host, port: config.port, accounts_dir: config.accountsDir, accounts: accounts.map((item) => ({ account: item.name, capture_exists: item.exists, settings_exists: item.hasSettings, error: item.error ?? null, capabilities: item.capabilities ?? null })), character_game: "removed", ready: true });
}

async function commandServer(args: Args): Promise<void> {
  const config = loadConfig({ ...process.env, HOST: stringArg(args, "host", process.env.HOST), PORT: stringArg(args, "port", process.env.PORT) });
  const server = createBridgeServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => { console.log(`gpt-bridge-node listening on http://${config.host}:${config.port}`); resolve(); });
  });
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}

async function commandApi(args: Args): Promise<void> {
  const action = args._[1] ?? "chat";
  const prompt = stringArg(args, "prompt") ?? stringArg(args, "message") ?? (process.stdin.isTTY ? "Say hello in one sentence." : fs.readFileSync(0, "utf8"));
  if (action === "chat") {
    const payload = await apiRequest(args, "/chat/completions", { method: "POST", body: JSON.stringify({ model: stringArg(args, "model", "chatgpt-web/auto"), messages: [{ role: "user", content: prompt }], stream: false }) });
    json(payload); return;
  }
  if (action === "vision") {
    const image = stringArg(args, "image");
    if (!image) throw new Error("api vision requires --image PATH_OR_DATA_URL");
    const encoded = image.startsWith("data:") ? image : `data:${path.extname(image).toLowerCase() === ".jpg" || path.extname(image).toLowerCase() === ".jpeg" ? "image/jpeg" : "image/png"};base64,${fs.readFileSync(image).toString("base64")}`;
    json(await apiRequest(args, "/chatgpt/vision", { method: "POST", body: JSON.stringify({ prompt, images: [encoded], mode: stringArg(args, "mode", "custom") }) })); return;
  }
  if (action === "image") {
    json(await apiRequest(args, "/images/generations", { method: "POST", body: JSON.stringify({ prompt, model: stringArg(args, "model", "auto"), response_format: stringArg(args, "response-format", "url") }) })); return;
  }
  throw new Error(`unknown api action: ${action}`);
}

async function commandAdmin(args: Args): Promise<void> {
  const action = args._[1] ?? "status";
  const pathName = action === "accounts" ? "/chatgpt/admin/accounts" : action === "artifacts" ? "/chatgpt/admin/artifacts" : "/chatgpt/admin/status";
  json(await apiRequest(args, pathName));
}

function commandSecrets(args: Args): void {
  const config = loadConfig();
  const key = loadSecretsKey(config.accountsDir);
  const action = args._[1] ?? "check";
  const captures = listAccountProfiles(config.accountsDir).filter((profile) => profile.exists);
  if (action === "check") { json({ accounts: captures.map((profile) => ({ account: profile.name, encrypted: fs.readFileSync(profile.capturePath, "utf8").startsWith("enc:v1:"), readable: (() => { try { readCaptureFile(profile.capturePath, key); return true; } catch { return false; } })() })) }); return; }
  if (action === "encrypt") {
    const results = captures.map((profile) => ({ account: profile.name, result: encryptOrReencryptFile(profile.capturePath, key, key) }));
    json({ accounts: results, note: "Uses the current owner-only key or passphrase; set CHATGPT_SECRETS_PASSPHRASE to use a passphrase." }); return;
  }
  throw new Error(`unknown secrets action: ${action}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "doctor";
  if (command === "doctor") return commandDoctor();
  if (command === "server" || command === "start") return commandServer(args);
  if (command === "api") return commandApi(args);
  if (command === "admin") return commandAdmin(args);
  if (command === "secrets") return commandSecrets(args);
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
