import prisma from "../db.server";

const SECRET_PATTERNS: RegExp[] = [
  /\b(EA|shp[a-z]{1,3}_)[A-Za-z0-9_-]{16,}\b/g, // Meta / Shopify tokens
  /bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /(access_token|token|secret|authorization)["'=:\s]+[A-Za-z0-9._-]{10,}/gi,
];

export function redact(text: string | null | undefined, max = 500): string {
  let s = String(text ?? "");
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function logEvent(args: {
  shop?: string | null;
  source: "shopify" | "whatsapp" | "bot" | "admin";
  event: string;
  level?: "info" | "error";
  detail?: string | null;
}) {
  try {
    await prisma.activityLog.create({
      data: {
        shop: args.shop ?? null,
        source: args.source,
        event: args.event,
        level: args.level ?? "info",
        detail: args.detail ? redact(args.detail) : null,
      },
    });
  } catch (e) {
    console.error("logEvent failed", redact(String(e)));
  }
}
