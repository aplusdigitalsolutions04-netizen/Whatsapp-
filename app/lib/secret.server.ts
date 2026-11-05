import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Encrypts secrets (API keys) stored in the database. The key is derived from SECRETS_KEY,
// falling back to the Shopify app secret, so a leaked DB file alone does not expose the keys.
function key(): Buffer {
  const seed = process.env.SECRETS_KEY || process.env.SHOPIFY_API_SECRET;
  if (!seed) throw new Error("Set SECRETS_KEY (or SHOPIFY_API_SECRET) to store API keys securely");
  return scryptSync(seed, "orderly-secrets-v1", 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(blob: string): string | null {
  try {
    const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return null; // wrong key or corrupted value
  }
}
