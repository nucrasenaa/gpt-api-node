import { createHash } from "node:crypto";

/** Decode the browser proof challenge embedded in a captured sentinel header. */
export function decodeProofConfig(proofHeader?: string): unknown[] | undefined {
  if (!proofHeader || !proofHeader.includes("gAAAAAB")) return undefined;
  const encoded = proofHeader.split("gAAAAAB", 2)[1]?.split("~", 1)[0];
  if (!encoded) return undefined;
  try {
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function defaultProofConfig(userAgent: string): unknown[] {
  const screen = [3008, 4010, 6000][Math.floor(Math.random() * 3)]! * [1, 2, 4][Math.floor(Math.random() * 3)]!;
  const parseTime = new Date().toUTCString();
  return [
    screen,
    parseTime,
    null,
    0,
    userAgent,
    "https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js",
    "dpl=1440a687921de39ff5ee56b92807faaadce73f13",
    "en",
    "en-US",
    null,
    "plugins−[object PluginArray]",
    ["_reactListeningcfilawjnerp", "_reactListening9ne2dfo1i47", "_reactListening410nzwhan2a"][Math.floor(Math.random() * 3)]!,
    ["alert", "ontransitionend", "onprogress"][Math.floor(Math.random() * 3)]!,
  ];
}

/** Generate the same bounded SHA3-512 proof token used by the web client. */
export function generateProofToken(
  required: boolean,
  seed: string,
  difficulty: string,
  userAgent: string,
  proofConfig?: unknown[],
): string | undefined {
  if (!required) return undefined;
  const proof = proofConfig ? structuredClone(proofConfig) : defaultProofConfig(userAgent);
  const prefixLength = difficulty.length;
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    proof[3] = attempt;
    const proofBase = Buffer.from(JSON.stringify(proof)).toString("base64");
    const hash = createHash("sha3-512").update(seed + proofBase).digest("hex");
    if (hash.slice(0, prefixLength) <= difficulty) return `gAAAAAB${proofBase}`;
  }
  const fallback = Buffer.from(JSON.stringify(seed)).toString("base64");
  return `gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${fallback}`;
}
