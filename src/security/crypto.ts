import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ENC_PREFIX = "enc:v1:";
export const MASTER_KEY_FILE = ".master.key";
export const MASTER_SALT_FILE = ".master.salt";
export const PBKDF2_ITERATIONS = 600_000;
export const PASSPHRASE_ENV_VAR = "CHATGPT_SECRETS_PASSPHRASE";

const FERNET_VERSION = 0x80;
const FERNET_KEY_BYTES = 32;
const FERNET_IV_BYTES = 16;
const FERNET_TAG_BYTES = 32;
const FERNET_MIN_TOKEN_BYTES = 1 + 8 + FERNET_IV_BYTES + 16 + FERNET_TAG_BYTES;

let runtimePassphrase: string | undefined;

function urlSafeBase64Encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function urlSafeBase64Decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function fernetKeyBytes(key: Buffer | string): Buffer {
  // The Python reference passes Fernet's ASCII/base64 key bytes. Accept a raw
  // 32-byte Buffer too when the caller already has PBKDF2 output.
  const decoded = Buffer.isBuffer(key) && key.length === FERNET_KEY_BYTES
    ? key
    : Buffer.isBuffer(key)
      ? urlSafeBase64Decode(key.toString("ascii"))
      : urlSafeBase64Decode(key);
  if (decoded.length !== FERNET_KEY_BYTES) {
    throw new TypeError("Fernet keys must decode to 32 bytes");
  }
  return decoded;
}

function keyFromParts(key: Buffer | string): { signing: Buffer; encryption: Buffer } {
  const decoded = fernetKeyBytes(key);
  return { signing: decoded.subarray(0, 16), encryption: decoded.subarray(16) };
}

function invalidTokenError(): Error {
  return new Error(
    "could not decrypt account capture: wrong CHATGPT_SECRETS_PASSPHRASE " +
      "or a corrupted/missing master key file",
  );
}

/** Return true only for the versioned encrypted capture format. */
export function isEncrypted(data: string): boolean {
  return data.startsWith(ENC_PREFIX);
}

/** Encrypt UTF-8 text using the Fernet wire format, prefixed with enc:v1:. */
export function encryptText(plaintext: string, key: Buffer | string): string {
  const { signing, encryption } = keyFromParts(key);
  const header = Buffer.alloc(1 + 8);
  header[0] = FERNET_VERSION;
  header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);
  const iv = crypto.randomBytes(FERNET_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-128-cbc", encryption, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const body = Buffer.concat([header, iv, ciphertext]);
  const tag = crypto.createHmac("sha256", signing).update(body).digest();
  return ENC_PREFIX + Buffer.concat([body, tag]).toString("base64");
}

/** Decrypt enc:v1: text, while preserving the reference's plaintext passthrough. */
export function decryptText(data: string, key: Buffer | string): string {
  if (!isEncrypted(data)) return data;

  try {
    const token = Buffer.from(data.slice(ENC_PREFIX.length), "base64");
    if (token.length < FERNET_MIN_TOKEN_BYTES || token[0] !== FERNET_VERSION) throw invalidTokenError();

    const signed = token.subarray(0, -FERNET_TAG_BYTES);
    const expectedTag = token.subarray(-FERNET_TAG_BYTES);
    const { signing, encryption } = keyFromParts(key);
    const actualTag = crypto.createHmac("sha256", signing).update(signed).digest();
    if (actualTag.length !== expectedTag.length || !crypto.timingSafeEqual(actualTag, expectedTag)) {
      throw invalidTokenError();
    }

    const iv = signed.subarray(1 + 8, 1 + 8 + FERNET_IV_BYTES);
    const ciphertext = signed.subarray(1 + 8 + FERNET_IV_BYTES);
    const decipher = crypto.createDecipheriv("aes-128-cbc", encryption, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("could not decrypt account capture:")) throw error;
    throw invalidTokenError();
  }
}

export function setRuntimePassphrase(passphrase: string): void {
  runtimePassphrase = passphrase;
}

export function clearRuntimePassphrase(): void {
  runtimePassphrase = undefined;
}

function expandHome(value: string): string {
  return value === "~" ? process.env.HOME ?? value : value.startsWith("~/")
    ? path.join(process.env.HOME ?? "~", value.slice(2))
    : value;
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function getOrCreateSalt(accountsDir: string): Buffer {
  ensureDirectory(accountsDir);
  const saltPath = path.join(accountsDir, MASTER_SALT_FILE);
  try {
    const salt = fs.readFileSync(saltPath);
    if (salt.length !== 16) throw new Error("invalid master salt");
    fs.chmodSync(saltPath, 0o600);
    return salt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const salt = crypto.randomBytes(16);
  try {
    const fd = fs.openSync(saltPath, "wx", 0o600);
    try {
      fs.writeSync(fd, salt);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return fs.readFileSync(saltPath);
  }
  return salt;
}

function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): string {
  const derived = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, "sha256");
  return urlSafeBase64Encode(derived);
}

function getOrCreateKeyFile(accountsDir: string): string {
  ensureDirectory(accountsDir);
  const keyPath = path.join(accountsDir, MASTER_KEY_FILE);
  try {
    const key = fs.readFileSync(keyPath, "ascii").trim();
    fernetKeyBytes(key);
    fs.chmodSync(keyPath, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = urlSafeBase64Encode(crypto.randomBytes(FERNET_KEY_BYTES));
  try {
    const fd = fs.openSync(keyPath, "wx", 0o600);
    try {
      fs.writeSync(fd, key, undefined, "ascii");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return fs.readFileSync(keyPath, "ascii").trim();
  }
  return key;
}

export function keyFilePath(accountsDir: string): string {
  return path.join(expandHome(accountsDir), MASTER_KEY_FILE);
}

/** Choose the runtime passphrase, environment passphrase, or owner-only key file. */
export function loadSecretsKey(accountsDir: string): string {
  const directory = expandHome(accountsDir);
  if (runtimePassphrase) return deriveKeyFromPassphrase(runtimePassphrase, getOrCreateSalt(directory));
  const passphrase = process.env[PASSPHRASE_ENV_VAR]?.trim();
  if (passphrase) return deriveKeyFromPassphrase(passphrase, getOrCreateSalt(directory));
  return getOrCreateKeyFile(directory);
}

/** Load the generated key file even when a passphrase is configured. */
export function loadAutoSecretsKey(accountsDir: string): string {
  return getOrCreateKeyFile(expandHome(accountsDir));
}

export function reencryptFile(pathname: string, oldKey: Buffer | string, newKey: Buffer | string): boolean {
  if (!fs.existsSync(pathname)) return false;
  const text = fs.readFileSync(pathname, "utf8");
  if (!isEncrypted(text)) return false;
  fs.writeFileSync(pathname, encryptText(decryptText(text, oldKey), newKey), "utf8");
  return true;
}

export type EncryptFileResult = "encrypted" | "rotated" | null;

export function encryptOrReencryptFile(
  pathname: string,
  oldKey: Buffer | string,
  newKey: Buffer | string,
): EncryptFileResult {
  if (!fs.existsSync(pathname)) return null;
  const text = fs.readFileSync(pathname, "utf8");
  const encrypted = isEncrypted(text);
  const plaintext = encrypted ? decryptText(text, oldKey) : text;
  fs.writeFileSync(pathname, encryptText(plaintext, newKey), "utf8");
  return encrypted ? "rotated" : "encrypted";
}

