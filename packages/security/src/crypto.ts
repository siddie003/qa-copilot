import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFrom(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Encryption key must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts a secret with AES-256-GCM (random 96-bit IV, authenticated). Output:
 * "v1.<iv>.<tag>.<ciphertext>" (base64url parts). Optional associated data binds the ciphertext
 * to a context (e.g. the project id) so it cannot be moved to another record.
 */
export function encryptSecret(plaintext: string, keyHex: string, associatedData?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyHex), iv);
  if (associatedData) cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptSecret(payload: string, keyHex: string, associatedData?: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined)
    throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(keyHex), Buffer.from(iv, "base64url"));
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
