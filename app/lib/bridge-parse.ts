/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InboundPayload } from "./bot.server";

type Raw = {
  key?: { id?: string; remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean };
  message?: Record<string, any> | null;
  pushName?: string;
  messageTimestamp?: number | string | { toString(): string };
};

/** Message kinds that are WhatsApp's own notices or reactions, not something a customer wrote to the shop. */
export const SYSTEM_TYPES = new Set([
  "protocolMessage", "senderKeyDistributionMessage", "reactionMessage", "encReactionMessage", "pollUpdateMessage", "keepInChatMessage",
  "pinInChatMessage", "messageContextInfo", "call", "callLogMesssage", "system", "reaction", "unsupported", "ephemeral", "request_welcome",
]);

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
  // "The message timer was updated", reactions, key exchanges: a stub type or only system parts means nothing to answer.
  if ((m as any).messageStubType) return null;
  const parts = Object.keys(msg).filter((k) => k !== "messageContextInfo");
  if (parts.length > 0 && parts.every((k) => SYSTEM_TYPES.has(k))) return null;
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
