/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InboundPayload } from "./bot.server";

type Raw = {
  key?: { id?: string; remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean };
  message?: Record<string, any> | null;
  pushName?: string;
  messageTimestamp?: number | string | { toString(): string };
};

/** Strips WhatsApp's wrapper messages (ephemeral, view-once, document-with-caption). */
export function unwrapMessage(msg: Record<string, any> | null | undefined): Record<string, any> {
  let m = msg ?? {};
  for (let i = 0; i < 4; i++) {
    const inner =
      m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ??
      m.documentWithCaptionMessage?.message ?? m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

const MEDIA_KEYS: [string, "image" | "video" | "audio" | "document" | "sticker"][] = [
  ["imageMessage", "image"], ["videoMessage", "video"], ["audioMessage", "audio"],
  ["documentMessage", "document"], ["stickerMessage", "sticker"],
];

/** Converts a Baileys message to our inbound shape. Ignores own, group, status and empty messages. */
export function parseBridgeMessage(m: Raw): { jid: string; payload: InboundPayload } | null {
  const key = m.key;
  if (!key?.id || !key.remoteJid || key.fromMe) return null;
  const jid = key.remoteJid;
  if (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) return null;

  // @lid chats hide the phone number; use the alternate JID when WhatsApp provides it.
  const phoneJid = jid.endsWith("@lid") ? (key.remoteJidAlt ?? jid) : jid;
  const from = phoneJid.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!from) return null;

  const msg = unwrapMessage(m.message);
  let text: string =
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.buttonsResponseMessage?.selectedDisplayText ??
    msg.listResponseMessage?.title ??
    "";
  let media: InboundPayload["media"];
  for (const [k, kind] of MEDIA_KEYS) {
    const part = msg[k];
    if (!part) continue;
    media = {
      kind,
      mime: String(part.mimetype ?? "application/octet-stream"),
      name: part.fileName ? String(part.fileName).slice(0, 120) : undefined,
    };
    if (!text) text = String(part.caption ?? "");
    break;
  }
  const type = media ? media.kind : text ? "text" : (Object.keys(msg)[0] ?? "unknown");
  if (!text && !media && !Object.keys(msg).length) return null;

  return {
    jid,
    payload: {
      id: key.id,
      from,
      type,
      text,
      name: m.pushName || undefined,
      timestamp: m.messageTimestamp != null ? String(m.messageTimestamp) : undefined,
      ...(media ? { media } : {}),
    },
  };
}
