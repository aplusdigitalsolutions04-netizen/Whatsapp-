import prisma from "../db.server";
import { handleInbound } from "./bot.server";
import { logEvent } from "./log.server";
import { rateLimited } from "./rate-limit.server";
import { getSettings, resolveShop } from "./settings.server";

// A chat with JAZZ on the website. It uses the same bot as WhatsApp (handleInbound); the conversation is marked channel "web",
// so replies are stored for the visitor's chat box instead of being sent through WhatsApp.

/** The support number used for the icon's WhatsApp button until the owner types another one. */
export const DEFAULT_WIDGET_WHATSAPP = "919211890093";

export const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TEXT = 500;

/**
 * The shop the website chat belongs to: the one whose owner switched the icon ON in Bot Settings. The public chat has no login, so
 * "which shop" cannot come from a session; taking the shop that has the switch on means the toggle always matches what visitors get,
 * even if the server's default shop (SHOPIFY_STORE_DOMAIN / newest session) is a different one. Falls back to that default.
 */
export async function widgetShop(): Promise<string | null> {
  const on = await prisma.botSettings.findFirst({ where: { webWidget: true }, orderBy: { updatedAt: "desc" }, select: { shop: true } });
  return on?.shop ?? (await resolveShop());
}

export async function webChatConfig(shop: string | null): Promise<{ enabled: boolean; whatsapp: string }> {
  if (!shop) return { enabled: false, whatsapp: DEFAULT_WIDGET_WHATSAPP };
  const s = await getSettings(shop);
  return { enabled: s.webWidget, whatsapp: s.widgetWhatsapp || DEFAULT_WIDGET_WHATSAPP };
}

export type WebMessage = { id: string; from: "me" | "jazz" | "agent"; text: string; at: string };

/** The visitor writes a message; JAZZ answers (the answer is read back with readWebMessages). */
export async function sendWebMessage(args: { shop: string; sid: string; text: string; name?: string; ip?: string; test?: boolean }): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { shop, sid, ip } = args;
  if (!SESSION_RE.test(sid)) return { ok: false, error: "Bad session", status: 400 };
  const text = args.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!text) return { ok: false, error: "Type a message", status: 400 };
  if (rateLimited(`webchat:sid:${sid}`, 20, 60_000) || (ip && rateLimited(`webchat:ip:${ip}`, 60, 60_000))) {
    return { ok: false, error: "You are sending messages too fast. Please wait a moment.", status: 429 };
  }
  const settings = await getSettings(shop);
  if (!args.test && !settings.webWidget) return { ok: false, error: "Chat is not available right now.", status: 403 };
  const name = (args.name ?? "").trim().slice(0, 40) || (args.test ? "You (test chat)" : "");
  try {
    await handleInbound(
      shop,
      { from: sid, id: `web-${sid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: "text", text, name: name || undefined },
      { channel: "web", phone: `web:${sid}` },
    );
  } catch (e) {
    // The bot already told the visitor that something went wrong; keep the real reason in the log.
    await logEvent({ shop, source: "bot", level: "error", event: "web_chat_failed", detail: (e as Error).message });
  }
  return { ok: true };
}

/** Messages of this visitor's chat newer than `after` (ISO time of the last one the page already has). */
export async function readWebMessages(shop: string, sid: string, after?: string | null): Promise<{ messages: WebMessage[]; mode: string }> {
  if (!SESSION_RE.test(sid)) return { messages: [], mode: "bot" };
  const conv = await prisma.conversation.findUnique({ where: { shop_phone: { shop, phone: `web:${sid}` } } });
  if (!conv || conv.channel !== "web") return { messages: [], mode: "bot" };
  const since = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
  const rows = await prisma.message.findMany({
    where: { conversationId: conv.id, status: { not: "failed" }, ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 60,
  });
  return {
    mode: conv.mode,
    messages: rows
      .filter((m) => m.body.trim())
      .map((m) => ({ id: m.id, from: m.direction === "in" ? "me" : m.sender === "agent" ? "agent" : "jazz", text: m.body, at: m.createdAt.toISOString() })),
  };
}
