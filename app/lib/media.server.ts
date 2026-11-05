import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MEDIA_DIR = path.resolve(process.env.WHATSAPP_MEDIA_DIR || ".wa-media");
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
  "application/msword": "doc", "application/vnd.ms-excel": "xls", "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** Types the browser may display inline. Everything else is forced to download (never rendered as HTML/SVG). */
export const INLINE_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "application/pdf",
]);

export const ALLOWED_UPLOAD_MIME = new Set(Object.keys(EXT));

export function kindFromMime(mime: string): "image" | "video" | "audio" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

const baseMime = (m: string) => m.split(";")[0].trim().toLowerCase();

/** Stores bytes under a random server-generated name; the customer-supplied filename is never used as a path. */
export function saveMedia(buffer: Buffer, mime: string): { file: string; mime: string } {
  const m = baseMime(mime);
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error("File is larger than 16 MB");
  mkdirSync(MEDIA_DIR, { recursive: true });
  const file = `${randomBytes(12).toString("hex")}.${EXT[m] ?? "bin"}`;
  writeFileSync(path.join(MEDIA_DIR, file), buffer);
  return { file, mime: m };
}

export function mediaFilePath(file: string): string | null {
  if (!/^[a-f0-9]{24}\.[a-z0-9]{1,5}$/.test(file)) return null;
  const p = path.join(MEDIA_DIR, file);
  return existsSync(p) ? p : null;
}

function key(): string {
  const seed = process.env.SECRETS_KEY || process.env.SHOPIFY_API_SECRET;
  if (!seed) throw new Error("SECRETS_KEY or SHOPIFY_API_SECRET is required to sign media links");
  return seed;
}

const sign = (id: string, exp: number) => createHmac("sha256", key()).update(`media:${id}:${exp}`).digest("hex");

/**
 * Time-limited signed link so <img>/<a> inside the embedded admin can load files without a session
 * header. The expiry is rounded to the hour so the URL stays stable between auto-refreshes.
 */
export function signedMediaUrl(id: string): string {
  const exp = (Math.floor(Date.now() / 3_600_000) + 2) * 3_600;
  return `/api/media/${id}?exp=${exp}&sig=${sign(id, exp)}`;
}

export function verifyMediaSignature(id: string, expRaw: string | null, sig: string | null): boolean {
  const exp = Number(expRaw);
  if (!sig || !Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const want = Buffer.from(sign(id, exp), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Signed link for a conversation's cached WhatsApp profile picture. */
export function signedAvatarUrl(conversationId: string): string {
  const exp = (Math.floor(Date.now() / 3_600_000) + 2) * 3_600;
  return `/api/avatar/${conversationId}?exp=${exp}&sig=${sign(`av-${conversationId}`, exp)}`;
}

export const verifyAvatarSignature = (id: string, exp: string | null, sig: string | null) => verifyMediaSignature(`av-${id}`, exp, sig);

/** Signed link for Product Scrapper files (photos, ZIP, CSV). `path` is e.g. "file/<run>/<folder>/1.jpg". */
export function signedFinderUrl(path: string): string {
  const exp = (Math.floor(Date.now() / 3_600_000) + 2) * 3_600;
  return `/api/finder/${path.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sign(`finder:${path}`, exp)}`;
}

export const verifyFinderSignature = (path: string, exp: string | null, sig: string | null) => verifyMediaSignature(`finder:${path}`, exp, sig);

/** Signed link for the SEO CSV download. `path` is "export/<scope>/<shop>": the shop is part of what is signed, so it cannot be swapped. */
export function signedSeoUrl(path: string): string {
  const exp = (Math.floor(Date.now() / 3_600_000) + 2) * 3_600;
  return `/api/seo/${path.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sign(`seo:${path}`, exp)}`;
}

export const verifySeoSignature = (path: string, exp: string | null, sig: string | null) => verifyMediaSignature(`seo:${path}`, exp, sig);

/** Signed link for Image Editor files (thumbnails, results, ZIP). `path` is e.g. "file/<job>/thumb/<item>". */
export function signedImageUrl(path: string): string {
  const exp = (Math.floor(Date.now() / 3_600_000) + 2) * 3_600;
  return `/api/image-editor/${path.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sign(`image:${path}`, exp)}`;
}

export const verifyImageSignature = (path: string, exp: string | null, sig: string | null) => verifyMediaSignature(`image:${path}`, exp, sig);
