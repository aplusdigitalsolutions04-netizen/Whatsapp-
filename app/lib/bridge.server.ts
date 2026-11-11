/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/rules-of-hooks, import/no-named-as-default */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import prisma from "../db.server";
import { logEvent, redact } from "./log.server";
import { normalizePhone } from "./phone";
import { parseBridgeMessage } from "./bridge-parse";
import { MAX_MEDIA_BYTES, mediaFilePath, saveMedia } from "./media.server";
import { applyStatus, processEvent, recordEvent } from "./webhook-processor.server";

/**
 * QR-linked WhatsApp Web bridge (unofficial, via Baileys). It feeds the same
 * dedupe + bot pipeline as the Cloud API webhook; only ONE provider is active
 * at a time (see activeProvider) so customers never get two replies.
 */
export type BridgeState = "stopped" | "starting" | "qr" | "connected" | "error";

type Bridge = {
  state: BridgeState;
  qr: string | null; // data URL
  error: string | null;
  number: string | null;
  sock: any;
  jids: Map<string, string>; // phone digits -> last seen JID (handles @lid chats)
  retries: number;
  lastUpsertAt: number | null; // when WhatsApp last delivered any message event
  received: number;
};

const g = globalThis as unknown as { __waBridge?: Bridge };
const bridge: Bridge = (g.__waBridge ??= {
  state: "stopped", qr: null, error: null, number: null, sock: null, jids: new Map(), retries: 0, lastUpsertAt: null, received: 0,
});

const AUTH_DIR = path.resolve(process.env.WHATSAPP_AUTH_DIR || ".wa-auth");

export function activeProvider(): "qr" | "cloud" {
  const p = process.env.WHATSAPP_PROVIDER;
  if (p === "qr" || p === "cloud") return p;
  return process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID ? "cloud" : "qr";
}

export const bridgeStatus = () => ({
  state: bridge.state, qr: bridge.qr, error: bridge.error, number: bridge.number,
  paired: existsSync(path.join(AUTH_DIR, "creds.json")),
  lastUpsertAt: bridge.lastUpsertAt,
  received: bridge.received,
});

export async function startBridge() {
  if (bridge.state === "starting" || bridge.state === "qr" || bridge.state === "connected") return;
  bridge.state = "starting";
  bridge.error = null;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.macOS("Orderly"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    bridge.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u: any) => {
      if (u.qr) {
        bridge.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 });
        bridge.state = "qr";
      }
      if (u.connection === "open") {
        bridge.state = "connected";
        bridge.qr = null;
        bridge.retries = 0;
        bridge.number = String(sock.user?.id ?? "").split(/[:@]/)[0] || null;
        await logEvent({ source: "whatsapp", event: "bridge_connected", detail: bridge.number });
      }
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        await logEvent({ source: "whatsapp", event: "bridge_closed", detail: `code=${code ?? "?"} ${redact(String((u.lastDisconnect?.error as any)?.message ?? ""), 120)}` });
        bridge.sock = null;
        bridge.qr = null;
        if (code === DisconnectReason.loggedOut) {
          rmSync(AUTH_DIR, { recursive: true, force: true });
          bridge.state = "stopped";
          bridge.number = null;
          await logEvent({ source: "whatsapp", event: "bridge_logged_out" });
        } else if (bridge.retries < 5) {
          bridge.retries++;
          bridge.state = "stopped";
          setTimeout(() => void startBridge(), 2000 * bridge.retries);
        } else {
          bridge.state = "error";
          bridge.error = "Connection lost repeatedly. Click Connect to try again.";
          await logEvent({ source: "whatsapp", level: "error", event: "bridge_error", detail: bridge.error });
        }
      }
    });

    sock.ev.on("messages.update", async (updates: any[]) => {
      for (const u of updates) {
        const st = u?.update?.status;
        const id = u?.key?.id;
        if (!id || !u.key.fromMe || typeof st !== "number") continue;
        // proto status: 3 = delivered, 4 = read, 5 = played
        const mapped = st >= 4 ? "read" : st === 3 ? "delivered" : null;
        if (mapped) await applyStatus({ id, status: mapped }).catch(() => undefined);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      bridge.lastUpsertAt = Date.now();
      for (const m of messages) {
        // Timestamps can be protobuf Long objects, so go through toString().
        const ts = Number(m?.messageTimestamp?.toString?.() ?? m?.messageTimestamp ?? 0);
        const ageSec = ts ? Date.now() / 1000 - ts : 0;
        const parsed = parseBridgeMessage(m);
        // "append" is history/offline sync: accept only fresh messages, never old backlog.
        const accept = type === "notify" || (type === "append" && ageSec < 180);
        if (!accept || !parsed) {
          if (!m?.key?.fromMe) {
            const why = `${type}; age=${Math.round(ageSec)}s; jid=${String(m?.key?.remoteJid ?? "").split("@")[1] ?? "?"}; content=${Object.keys(m?.message ?? {}).join(",") || "none"}`;
            await logEvent({ source: "whatsapp", event: "bridge_message_ignored", detail: why });
          }
          continue;
        }
        bridge.received++;
        bridge.jids.set(parsed.payload.from, parsed.jid);
        void bridge.sock?.readMessages([m.key]).catch(() => undefined); // blue ticks for the customer
        if (parsed.payload.media && parsed.payload.media.kind !== "sticker") {
          try {
            const buf = (await downloadMediaMessage(m, "buffer", {}, { logger: undefined as any, reuploadRequest: bridge.sock.updateMediaMessage })) as Buffer;
            if (buf.length <= MAX_MEDIA_BYTES) parsed.payload.media.file = saveMedia(buf, parsed.payload.media.mime).file;
            else await logEvent({ source: "whatsapp", event: "media_too_large", detail: `${buf.length} bytes` });
          } catch (e) {
            await logEvent({ source: "whatsapp", level: "error", event: "media_download_failed", detail: (e as Error).message });
          }
        }
        const id = await recordEvent({ kind: "message", key: parsed.payload.id, payload: parsed.payload });
        if (id) await processEvent(id);
        void refreshAvatar(parsed.payload.from, parsed.jid);
      }
    });
  } catch (e) {
    bridge.state = "error";
    bridge.error = redact((e as Error).message);
    await logEvent({ source: "whatsapp", level: "error", event: "bridge_error", detail: bridge.error });
  }
}

/** Caches the customer's WhatsApp profile picture (at most once a day per chat; private photos just stay empty). */
async function refreshAvatar(from: string, jid: string) {
  try {
    const phone = normalizePhone(from) ?? `+${from.replace(/\D/g, "")}`;
    const conv = await prisma.conversation.findFirst({ where: { phone }, select: { id: true, avatarAt: true } });
    if (!conv || (conv.avatarAt && Date.now() - conv.avatarAt.getTime() < 24 * 3_600_000)) return;
    let file: string | null = null;
    for (const j of [jid, `${from.replace(/\D/g, "")}@s.whatsapp.net`]) {
      const url: string | undefined = await bridge.sock?.profilePictureUrl(j, "image").catch(() => undefined);
      if (!url) continue;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0 && buf.length <= MAX_MEDIA_BYTES) {
        file = saveMedia(buf, "image/jpeg").file;
        break;
      }
    }
    await prisma.conversation.update({ where: { id: conv.id }, data: { avatarAt: new Date(), ...(file ? { avatarFile: file } : {}) } });
  } catch {
    /* a missing profile picture is never an error for the bot */
  }
}

export async function stopBridge(logout: boolean) {
  const sock = bridge.sock;
  bridge.sock = null;
  bridge.retries = 99; // suppress auto-reconnect from the close handler
  try {
    if (logout) await sock?.logout();
    else sock?.end(undefined);
  } catch {
    /* already closed */
  }
  if (logout) rmSync(AUTH_DIR, { recursive: true, force: true });
  bridge.state = "stopped";
  bridge.qr = null;
  bridge.number = logout ? null : bridge.number;
  bridge.retries = 0;
}

const NOT_CONNECTED = "WhatsApp is not connected (scan the QR code on the WhatsApp Web page)";

/** The connection can drop for a moment (WhatsApp reconnects by itself); wait briefly for it instead of failing. */
async function liveSock(waitMs = 0) {
  const until = Date.now() + waitMs;
  for (;;) {
    if (bridge.state === "connected" && bridge.sock) return bridge.sock;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function bridgeSendText(
  toPhone: string,
  body: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (bridge.state !== "connected" || !bridge.sock) {
    return { ok: false, error: NOT_CONNECTED };
  }
  const digits = toPhone.replace(/\D/g, "");
  const jid = bridge.jids.get(digits) ?? `${digits}@s.whatsapp.net`;
  try {
    // Show "typing…" briefly so the chat feels human.
    await bridge.sock.sendPresenceUpdate("composing", jid).catch(() => undefined);
    await new Promise((r) => setTimeout(r, Math.min(1800, 400 + body.length * 8)));
    const res = await bridge.sock.sendMessage(jid, { text: body });
    void bridge.sock?.sendPresenceUpdate("paused", jid).catch(() => undefined);
    return { ok: true, id: res?.key?.id ?? `qr-${Date.now()}` };
  } catch (e) {
    return { ok: false, error: redact((e as Error).message) };
  }
}

/** Auto-reconnect after a server restart if this device was already paired. */
export function autostartBridge() {
  if (activeProvider() === "qr" && existsSync(path.join(AUTH_DIR, "creds.json"))) void startBridge();
}

export async function bridgeSendMedia(
  toPhone: string,
  media: { kind: string; mime: string; name?: string; file: string },
  caption: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (bridge.state !== "connected" || !bridge.sock) {
    return { ok: false, error: NOT_CONNECTED };
  }
  const filePath = mediaFilePath(media.file);
  if (!filePath) return { ok: false, error: "Attachment file is missing on the server" };
  const digits = toPhone.replace(/\D/g, "");
  const jid = bridge.jids.get(digits) ?? `${digits}@s.whatsapp.net`;
  const buffer = readFileSync(filePath);
  const text = caption.trim() || undefined;
  const content: any =
    media.kind === "image" ? { image: buffer, caption: text, mimetype: media.mime }
    : media.kind === "video" ? { video: buffer, caption: text, mimetype: media.mime }
    : media.kind === "audio" ? { audio: buffer, mimetype: media.mime }
    : { document: buffer, caption: text, mimetype: media.mime, fileName: media.name ?? media.file };
  try {
    const sock = await liveSock(10_000);
    if (!sock) return { ok: false, error: NOT_CONNECTED };
    const res = await sock.sendMessage(jid, content);
    return { ok: true, id: res?.key?.id ?? `qr-${Date.now()}` };
  } catch (e) {
    return { ok: false, error: redact((e as Error).message) };
  }
}
