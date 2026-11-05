import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice(7), "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
