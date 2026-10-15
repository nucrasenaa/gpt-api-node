import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearRuntimePassphrase,
  decryptText,
  encryptOrReencryptFile,
  encryptText,
  isEncrypted,
  loadAutoSecretsKey,
  loadSecretsKey,
} from "../../security/crypto.js";
import { listAccountProfiles, resolveAccountCapturePath } from "../../storage/accounts.js";
import { createArtifactMetadata } from "../../storage/artifacts.js";
import { BridgeAdminStore } from "../../storage/admin-store.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gpt-bridge-storage-"));
}

test("enc:v1 round-trips and keeps legacy plaintext readable", () => {
  const root = temporaryDirectory();
  const key = loadAutoSecretsKey(path.join(root, "accounts"));
  const encrypted = encryptText("hello secret", key);

  assert.equal(isEncrypted(encrypted), true);
  assert.equal(decryptText(encrypted, key), "hello secret");
  assert.equal(decryptText("legacy capture", key), "legacy capture");
  assert.equal(fs.statSync(path.join(root, "accounts", ".master.key")).mode & 0o777, 0o600);
});

test("account names are safe and encrypted files can be migrated", () => {
  const root = temporaryDirectory();
  const accountsDir = path.join(root, "accounts");
  assert.equal(resolveAccountCapturePath("pro", accountsDir), path.join(accountsDir, "pro", "chatgpt-request.txt"));
  assert.throws(() => resolveAccountCapturePath("../pro", accountsDir));
  fs.mkdirSync(path.join(accountsDir, "pro"), { recursive: true });
  fs.mkdirSync(path.join(accountsDir, "pro.account"), { recursive: true });
  fs.writeFileSync(path.join(accountsDir, "pro", "chatgpt-request.txt"), "URL: https://chatgpt.com\n");
  assert.deepEqual(listAccountProfiles(accountsDir).map((profile) => profile.name), ["pro"]);

  const key = loadSecretsKey(accountsDir);
  const capturePath = path.join(accountsDir, "pro", "chatgpt-request.txt");
  assert.equal(encryptOrReencryptFile(capturePath, key, key), "encrypted");
  assert.equal(decryptText(fs.readFileSync(capturePath, "utf8"), key), "URL: https://chatgpt.com\n");
});

test("admin store removes stale artifacts and persists settings", () => {
  const root = temporaryDirectory();
  const livePath = path.join(root, "live.png");
  fs.writeFileSync(livePath, "png");
  const store = new BridgeAdminStore(path.join(root, "admin.sqlite"));
  store.recordArtifact(createArtifactMetadata(livePath, { id: "live" }), { kind: "image" });
  store.recordArtifact({
    id: "missing",
    filename: "missing.png",
    path: path.join(root, "missing.png"),
    download_url: "/missing",
    content_type: "image/png",
    bytes: null,
  }, { kind: "image" });

  assert.deepEqual(store.listArtifacts().map((artifact) => artifact.file_id), ["live"]);
  assert.equal(store.artifactCount(), 1);
  store.setSetting("feature", { enabled: true });
  assert.deepEqual(store.getSetting("feature"), { enabled: true });
  assert.equal(store.deleteSetting("feature"), true);
  clearRuntimePassphrase();
});

