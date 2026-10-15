import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ArtifactAsset {
  id: string;
  filename: string;
  path: string;
  download_url: string;
  content_type: string;
  bytes: number | null;
}

export interface ArtifactMetadataOptions {
  id?: string;
  filename?: string;
  contentType?: string;
  content_type?: string;
  publicBaseUrl?: string;
  public_base_url?: string;
  routePrefix?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

export function guessContentType(pathname: string): string {
  return CONTENT_TYPES[path.extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

export function filesystemMetadata(pathname: string): { path: string; exists: boolean; bytes: number | null } {
  const resolved = path.resolve(pathname);
  try {
    const stat = fs.statSync(resolved);
    return { path: resolved, exists: stat.isFile(), bytes: stat.isFile() ? stat.size : null };
  } catch {
    return { path: resolved, exists: false, bytes: null };
  }
}

function publicDownloadUrl(relativeUrl: string, publicBaseUrl: string | undefined): string {
  if (!publicBaseUrl) return relativeUrl;
  const base = publicBaseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1") && relativeUrl.startsWith("/v1/")) return base + relativeUrl.slice(3);
  return base + relativeUrl;
}

/** Build the stable filesystem metadata shape persisted by the admin store. */
export function createArtifactMetadata(pathname: string, options: ArtifactMetadataOptions = {}): ArtifactAsset {
  const resolved = path.resolve(pathname);
  const filename = options.filename || path.basename(resolved) || "download";
  const id = options.id || randomUUID().replaceAll("-", "");
  const routePrefix = options.routePrefix ?? "/v1/chatgpt/files";
  const relativeUrl = `${routePrefix.replace(/\/+$/, "")}/${id}/${encodeURIComponent(filename)}`;
  const stat = filesystemMetadata(resolved);
  return {
    id,
    filename,
    path: resolved,
    download_url: publicDownloadUrl(relativeUrl, options.publicBaseUrl ?? options.public_base_url),
    content_type: options.contentType ?? options.content_type ?? guessContentType(resolved),
    bytes: stat.bytes,
  };
}

export const registerArtifact = createArtifactMetadata;
export const artifactMetadata = createArtifactMetadata;

