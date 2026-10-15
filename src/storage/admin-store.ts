import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactAsset } from "./artifacts.js";

export interface RecordArtifactOptions {
  kind: string;
  account?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredArtifact {
  file_id: string;
  kind: string;
  filename: string;
  path: string;
  download_url: string;
  content_type: string;
  bytes: number | null;
  account: string | null;
  prompt: string | null;
  metadata: unknown;
  created_at: string;
  exists: boolean;
}

export interface AccountCaptureInspection {
  detected?: { plan_type?: string | null; email?: string | null; [key: string]: unknown };
  capabilities?: unknown;
  checks?: unknown;
}

export interface StoredAccountCapture {
  account: string;
  capture_path: string;
  plan_type: string | null;
  email: string | null;
  capabilities: unknown;
  checks: unknown;
  updated_at: string;
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function expandHome(value: string): string {
  return value === "~" ? process.env.HOME ?? value : value.startsWith("~/")
    ? path.join(process.env.HOME ?? "~", value.slice(2))
    : value;
}

function jsonOrEmpty(value: unknown): unknown {
  if (typeof value !== "string" || !value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function artifactId(asset: Record<string, unknown>): string {
  return String(asset.id ?? asset.file_id ?? "");
}

function assetValue(asset: Record<string, unknown>, camel: string, snake: string): unknown {
  return asset[camel] ?? asset[snake];
}

export class BridgeAdminStore {
  public readonly path: string;

  public constructor(databasePath: string) {
    this.path = path.resolve(expandHome(databasePath));
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    this.migrate();
  }

  private withDatabase<T>(callback: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  private migrate(): void {
    this.withDatabase((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          file_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          filename TEXT NOT NULL,
          path TEXT NOT NULL,
          download_url TEXT NOT NULL,
          content_type TEXT NOT NULL,
          bytes INTEGER,
          account TEXT,
          prompt TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS artifacts_created_idx ON artifacts(created_at DESC);
        CREATE TABLE IF NOT EXISTS account_captures (
          account TEXT PRIMARY KEY,
          capture_path TEXT NOT NULL,
          plan_type TEXT,
          email_masked TEXT,
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          checks_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }

  public recordArtifact(
    asset: ArtifactAsset | Record<string, unknown>,
    options: RecordArtifactOptions | string,
    account?: string,
    prompt?: string,
    metadata?: Record<string, unknown>,
  ): void {
    const normalized = typeof options === "string"
      ? { kind: options, account, prompt, metadata }
      : options;
    const raw = asset as Record<string, unknown>;
    const fileId = artifactId(raw);
    const createdAt = utcNow();
    this.withDatabase((db) => {
      const statement = db.prepare(`
        INSERT OR REPLACE INTO artifacts (
          file_id, kind, filename, path, download_url, content_type, bytes,
          account, prompt, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
          (SELECT created_at FROM artifacts WHERE file_id = ?), ?
        ))
      `);
      statement.run(
        fileId,
        normalized.kind,
        String(assetValue(raw, "filename", "filename") ?? "download"),
        String(assetValue(raw, "path", "path") ?? ""),
        String(assetValue(raw, "downloadUrl", "download_url") ?? ""),
        String(assetValue(raw, "contentType", "content_type") ?? "application/octet-stream"),
        asNumberOrNull(assetValue(raw, "bytes", "bytes")),
        normalized.account ?? null,
        normalized.prompt ?? null,
        JSON.stringify(normalized.metadata ?? {}, (_key, value: unknown) => value),
        fileId,
        createdAt,
      );
    });
  }

  public listArtifacts(limit = 100): StoredArtifact[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit)) || 1, 500));
    const artifacts = this.withDatabase((db) => {
      const rows = db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?").all(safeLimit * 4);
      return rows.map((row) => this.artifactRow(row));
    });
    const staleIds = artifacts.filter((item) => !item.exists).map((item) => item.file_id);
    if (staleIds.length) this.deleteArtifacts(staleIds);
    return artifacts.filter((item) => item.exists).slice(0, safeLimit);
  }

  public getArtifact(fileId: string): StoredArtifact | null {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT * FROM artifacts WHERE file_id = ?").get(fileId);
      return row ? this.artifactRow(row) : null;
    });
  }

  public artifactCount(): number {
    const rows = this.withDatabase((db) => db.prepare("SELECT file_id, path FROM artifacts").all());
    const staleIds = rows.filter((row) => !this.fileExists(String(row.path)))
      .map((row) => String(row.file_id));
    if (staleIds.length) this.deleteArtifacts(staleIds);
    return rows.length - staleIds.length;
  }

  public deleteArtifact(fileId: string): StoredArtifact | null {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT * FROM artifacts WHERE file_id = ?").get(fileId);
      if (!row) return null;
      const artifact = this.artifactRow(row);
      db.prepare("DELETE FROM artifacts WHERE file_id = ?").run(fileId);
      return artifact;
    });
  }

  public deleteArtifacts(fileIds: string[]): number {
    const safeIds = fileIds.filter(Boolean);
    if (!safeIds.length) return 0;
    return this.withDatabase((db) => {
      const placeholders = safeIds.map(() => "?").join(",");
      return Number(db.prepare(`DELETE FROM artifacts WHERE file_id IN (${placeholders})`).run(...safeIds).changes);
    });
  }

  public recordAccountCapture(account: string, capturePath: string, inspection: AccountCaptureInspection): void {
    const detected = inspection.detected && typeof inspection.detected === "object" ? inspection.detected : {};
    this.withDatabase((db) => {
      db.prepare(`
        INSERT OR REPLACE INTO account_captures (
          account, capture_path, plan_type, email_masked,
          capabilities_json, checks_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        account,
        capturePath,
        typeof detected.plan_type === "string" ? detected.plan_type : null,
        typeof detected.email === "string" ? detected.email : null,
        JSON.stringify(inspection.capabilities ?? {}),
        JSON.stringify(inspection.checks ?? []),
        utcNow(),
      );
    });
  }

  public listAccountCaptures(): StoredAccountCapture[] {
    return this.withDatabase((db) => db.prepare("SELECT * FROM account_captures ORDER BY account ASC").all()
      .map((row) => ({
        account: String(row.account),
        capture_path: String(row.capture_path),
        plan_type: stringOrNull(row.plan_type),
        email: stringOrNull(row.email_masked),
        capabilities: jsonOrEmpty(row.capabilities_json),
        checks: jsonOrEmpty(row.checks_json),
        updated_at: String(row.updated_at),
      })));
  }

  public deleteAccountCapture(account: string): boolean {
    return this.withDatabase((db) => Number(db.prepare("DELETE FROM account_captures WHERE account = ?").run(account).changes) > 0);
  }

  public getSetting<T = unknown>(key: string, defaultValue: T | null = null): T | null {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
      if (!row) return defaultValue;
      try {
        return JSON.parse(String(row.value_json)) as T;
      } catch {
        return defaultValue;
      }
    });
  }

  public setSetting(key: string, value: unknown): void {
    this.withDatabase((db) => {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)`)
        .run(key, JSON.stringify(value), utcNow());
    });
  }

  public deleteSetting(key: string): boolean {
    return this.withDatabase((db) => Number(db.prepare("DELETE FROM settings WHERE key = ?").run(key).changes) > 0);
  }

  private artifactRow(row: Record<string, unknown>): StoredArtifact {
    const pathname = String(row.path ?? "");
    return {
      file_id: String(row.file_id),
      kind: String(row.kind),
      filename: String(row.filename),
      path: pathname,
      download_url: String(row.download_url),
      content_type: String(row.content_type),
      bytes: asNumberOrNull(row.bytes),
      account: stringOrNull(row.account),
      prompt: stringOrNull(row.prompt),
      metadata: jsonOrEmpty(row.metadata_json),
      created_at: String(row.created_at),
      exists: this.fileExists(pathname),
    };
  }

  private fileExists(pathname: string): boolean {
    try {
      return fs.statSync(pathname).isFile();
    } catch {
      return false;
    }
  }
}

