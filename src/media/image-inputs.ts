import fs from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "../errors.js";

export interface ImageInput {
  data: Buffer;
  mimeType: string;
  name?: string;
}

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function mimeFromName(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    default: return "image/png";
  }
}

function parseDataUrl(value: string): ImageInput | undefined {
  const match = value.match(/^data:([^;,]+)(?:;[^,]+)*;base64,(.+)$/s);
  if (!match?.[1] || !match[2]) return undefined;
  const data = Buffer.from(match[2], "base64");
  if (data.byteLength > MAX_IMAGE_BYTES) throw new BridgeError("image is too large", 413, "image_too_large");
  return { data, mimeType: match[1] };
}

async function one(value: unknown): Promise<ImageInput> {
  if (typeof value === "string") {
    const dataUrl = parseDataUrl(value);
    if (dataUrl) return dataUrl;
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length > 64) {
      const data = Buffer.from(value, "base64");
      if (data.byteLength > MAX_IMAGE_BYTES) throw new BridgeError("image is too large", 413, "image_too_large");
      return { data, mimeType: "image/png" };
    }
    const file = await fs.readFile(value);
    if (file.byteLength > MAX_IMAGE_BYTES) throw new BridgeError("image is too large", 413, "image_too_large");
    return { data: file, mimeType: mimeFromName(value), name: path.basename(value) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("each image must be a data URL, path, or image object", 400, "invalid_request_error");
  }
  const item = value as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : undefined;
  const mimeType = typeof item.mime_type === "string" ? item.mime_type : typeof item.mimeType === "string" ? item.mimeType : undefined;
  const source = item.data_url ?? item.dataUrl ?? item.path ?? item.url ?? item.data;
  if (typeof source !== "string") throw new BridgeError("image object is missing data_url or path", 400, "invalid_request_error");
  const parsed = parseDataUrl(source);
  if (parsed) return { ...parsed, mimeType: mimeType ?? parsed.mimeType, name };
  const result = await one(source);
  return { ...result, mimeType: mimeType ?? result.mimeType, name: name ?? result.name };
}

export async function imageInputsFromBody(body: Record<string, unknown>, required = false): Promise<ImageInput[]> {
  const value = body.images ?? body.input_images ?? body.inputImages;
  if (value === undefined) {
    if (required) throw new BridgeError("images must contain at least one image", 400, "invalid_request_error");
    return [];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeError("images must be a non-empty list", 400, "invalid_request_error");
  }
  if (value.length > MAX_IMAGES) throw new BridgeError(`a maximum of ${MAX_IMAGES} images is supported`, 400, "invalid_request_error");
  return Promise.all(value.map(one));
}

export function imageExtension(mimeType: string | undefined): string {
  const base = (mimeType ?? "image/png").split(";", 1)[0] ?? "image/png";
  switch (base.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    default: return ".png";
  }
}
