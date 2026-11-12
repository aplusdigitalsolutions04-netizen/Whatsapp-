/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/rules-of-hooks, import/no-named-as-default */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { explainClose } from "./bridge-reasons";
import { normalizePhone } from "./phone";
import { rememberContacts } from "./saved-contacts.server";
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
  connectedAt: number | null;
  lastClose: { at: number; code?: number; title: string; advice: string } | null;
  manualStop: boolean; // the person pressed Disconnect: do not reconnect by itself
  watchdog: NodeJS.Timeout | null; // gives up on a connection attempt that never answers
  heartbeat: NodeJS.Timeout | null; // keeps the "this copy of the app owns the login" lock fresh
  reconnect: NodeJS.Timeout | null;
};

const g = globalThis as unknown as { __waBridge?: Bridge };
const bridge: Bridge = (g.__waBridge ??= {
  state: "stopped", qr: null, error: null, number: null, sock: null, jids: new Map(), retries: 0, lastUpsertAt: null, received: 0,
  connectedAt: null, lastClose: null, manualStop: false, watchdog: null, heartbeat: null, reconnect: null,
});

const AUTH_DIR = path.resolve(process.env.WHATSAPP_AUTH_DIR || ".wa-auth");

export function activeProvider(): "qr" | "cloud" {
  const p = process.env.WHATSAPP_PROVIDER;
  if (p === "qr" || p === "cloud") return p;
  return process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID ? "cloud" : "qr";
}

// ---- one copy of the app at a time ----
// Two copies of the app using the SAME WhatsApp login kick each other off again and again ("connection replaced").
// This can happen on hosting (old and new process during a redeploy, or several worker processes). A small lock file
// in the login folder says which process owns the connection; the others wait.
const LOCK = path.join(AUTH_DIR, "bridge.lock");
export function lockedByOther(file: string = LOCK): boolean {
  try {
    const l = JSON.parse(readFileSync(file, "utf8")) as { pid: number; at: number };
    if (l.pid === process.pid || Date.now() - l.at > 45_000) return false;
    try {
      process.kill(l.pid, 0); // throws when that process is gone
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
function writeLock() {
  try {
    mkdirSync(AUTH_DIR, { recursive: true });
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    /* the lock is a safety net, never a reason to fail */
  }
}
function releaseLock() {
  try {
    const l = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number };
    if (l.pid === process.pid) rmSync(LOCK, { force: true });
  } catch {
    /* no lock */
  }
}
process.once("exit", releaseLock);

const clearTimers = () => {
  for (const k of ["watchdog", "reconnect"] as const) {
    if (bridge[k]) clearTimeout(bridge[k]!);
    bridge[k] = null;
  }
};
const hasLogin = () => existsSync(path.join(AUTH_DIR, "creds.json"));

/** Reconnect later. Waits longer after every failure (2 s, 4 s, 8 s ... up to 60 s) and never gives up while the login exists. */
function scheduleReconnect(why: string, immediate = false) {
  if (bridge.reconnect) return;
  const wait = immediate ? 500 : Math.min(60_000, 2000 * 2 ** Math.min(bridge.retries, 5));
  if (!immediate) bridge.retries++;
  bridge.state = "stopped";
  bridge.error = `${why} Reconnecting in ${Math.round(wait / 1000)} s…`;
  bridge.reconnect = setTimeout(() => {
    bridge.reconnect = null;
    void startBridge();
  }, wait);
}

export const bridgeStatus = () => ({
  state: bridge.state, qr: bridge.qr, error: bridge.error, number: bridge.number,
  paired: existsSync(path.join(AUTH_DIR, "creds.json")),
  lastUpsertAt: bridge.lastUpsertAt,
  received: bridge.received,
  lastClose: bridge.lastClose,
  uptimeSec: Math.round(process.uptime()),
});

export async function startBridge() {
  if (bridge.state === "starting" || bridge.state === "qr" || bridge.state === "connected") return;
  if (lockedByOther()) {
    bridge.state = "stopped";
    bridge.error = "Another copy of the app is connected to this WhatsApp login right now. Waiting for it to stop…";
    if (!bridge.reconnect) bridge.reconnect = setTimeout(() => { bridge.reconnect = null; void startBridge(); }, 30_000);
    return;
  }
  clearTimers();
  bridge.manualStop = false;
  bridge.state = "starting";
  bridge.error = null;
  writeLock();
  bridge.heartbeat ??= setInterval(() => (bridge.state === "stopped" || bridge.state === "error" ? undefined : writeLock()), 15_000);
  bridge.heartbeat.unref?.();
  // A connection attempt that never answers must not leave the bridge stuck on "starting" forever.
  bridge.watchdog = setTimeout(() => {
    if (bridge.state !== "starting") return;
    try {
      bridge.sock?.end(undefined);
    } catch {
      /* already closed */
    }
    bridge.sock = null;
    scheduleReconnect("WhatsApp did not answer.");
  }, 90_000);
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.macOS("ShopPilot"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async (key: any) => sentCache.get(String(key?.id ?? "")),
      keepAliveIntervalMs: 25_000, // a ping to WhatsApp every 25 s keeps idle connections from being dropped
      connectTimeoutMs: 60_000,
    });
    bridge.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    // Names saved in the phone's address book: the bot stays silent for those people (see saved-contacts.ts).
    sock.ev.on("contacts.upsert", (l: any[]) => rememberContacts(l));
    sock.ev.on("contacts.update", (l: any[]) => rememberContacts(l));
    sock.ev.on("messaging-history.set", (h: any) => rememberContacts(h?.contacts));

    sock.ev.on("connection.update", async (u: any) => {
      if (u.qr || u.connection === "open" || u.connection === "close") {
        if (bridge.watchdog) clearTimeout(bridge.watchdog);
        bridge.watchdog = null;
      }
      if (u.qr) {
        bridge.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 });
        bridge.state = "qr";
      }
      if (u.connection === "open") {
        bridge.state = "connected";
        bridge.qr = null;
        bridge.error = null;
        bridge.connectedAt = Date.now();
        bridge.number = String(sock.user?.id ?? "").split(/[:@]/)[0] || null;
        await logEvent({ source: "whatsapp", event: "bridge_connected", detail: bridge.number });
        // Messages that could not go out while WhatsApp was offline are sent now (only the ones not sent yet).
        void import("./order-notify.server").then((m) => m.onWhatsAppConnected()).catch(() => undefined);
      }
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        await logEvent({ source: "whatsapp", event: "bridge_closed", detail: `code=${code ?? "?"} ${redact(String((u.lastDisconnect?.error as any)?.message ?? ""), 120)}` });
        try {
          sock.end(undefined);
        } catch {
          /* already closed */
        }
        if (bridge.sock === sock) bridge.sock = null;
        bridge.qr = null;
        const why = explainClose(code, String((u.lastDisconnect?.error as any)?.message ?? ""));
        bridge.lastClose = { at: Date.now(), code, ...why };
        if (bridge.manualStop) {
          bridge.state = "stopped"; // the person pressed Disconnect; this close is the result, not a failure
          return;
        }
        // A connection that stayed up for a minute was healthy: the next failure starts the waiting times from the beginning.
        if (bridge.connectedAt && Date.now() - bridge.connectedAt > 60_000) bridge.retries = 0;
        bridge.connectedAt = null;
        if (code === DisconnectReason.loggedOut) {
          rmSync(AUTH_DIR, { recursive: true, force: true });
          bridge.state = "stopped";
          bridge.number = null;
          bridge.error = "WhatsApp logged this device out (it was removed in the phone's Linked devices). Scan the QR code again.";
          await logEvent({ source: "whatsapp", event: "bridge_logged_out" });
        } else if (code === DisconnectReason.connectionReplaced) {
          // The same login is open somewhere else (another server, or a copy of the login folder on a PC). Fighting for it
          // would disconnect both again and again, so stop and say so.
          bridge.state = "error";
          bridge.error = "This WhatsApp login was opened somewhere else (another server or your PC). Close it there, then press Connect.";
          await logEvent({ source: "whatsapp", level: "error", event: "bridge_replaced", detail: bridge.error });
        } else if (!hasLogin()) {
          // Never paired: the QR code simply expired. Do not keep making new QR codes forever.
          bridge.state = "stopped";
          bridge.error = "The QR code expired. Press Connect to get a new one.";
        } else if (code === DisconnectReason.restartRequired) {
          scheduleReconnect("WhatsApp asked for a restart.", true); // normal right after scanning
        } else {
          scheduleReconnect(`${why.title}${code ? ` (code ${code})` : ""}.`);
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
        if (mapped) {
          remember(acks, id, mapped);
          await applyStatus({ id, status: mapped }).catch(() => undefined);
        }
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
  bridge.manualStop = true;
  clearTimers();
  if (bridge.heartbeat) clearInterval(bridge.heartbeat);
  bridge.heartbeat = null;
  releaseLock();
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
  bridge.error = null;
  bridge.retries = 0;
}

const NOT_CONNECTED = "WhatsApp is not connected (scan the QR code on the WhatsApp Web page)";

// Recent outgoing messages. WhatsApp sometimes asks the sender to send a message again (the customer's phone could not
// decrypt it). Without a copy to hand over, the customer sees "Waiting for this message" and never gets the text.
const sentCache = new Map<string, any>();
// Delivery confirmations from the customers' phones: message id -> "delivered" | "read".
const acks = new Map<string, string>();
function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value);
  if (map.size > 500) map.delete(map.keys().next().value as string);
}
export const bridgeAck = (id: string) => acks.get(id) ?? null;

/** The address WhatsApp wants for this number: the one we already know from a chat, else ask WhatsApp (it also says whether the number has WhatsApp at all). */
async function resolveJid(sock: any, digits: string): Promise<{ jid: string } | { error: string }> {
  const known = bridge.jids.get(digits);
  if (known) return { jid: known };
  const plain = `${digits}@s.whatsapp.net`;
  try {
    const r = await sock.onWhatsApp(plain);
    const hit = Array.isArray(r) ? r[0] : null;
    if (hit && hit.exists === false) return { error: "This number is not on WhatsApp." };
    if (hit?.jid) {
      bridge.jids.set(digits, hit.jid);
      return { jid: hit.jid };
    }
  } catch {
    /* the lookup is only a help: send to the plain address */
  }
  return { jid: plain };
}

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
  const first = await liveSock(8_000);
  if (!first) return { ok: false, error: NOT_CONNECTED };
  const digits = toPhone.replace(/\D/g, "");
  try {
    const target = await resolveJid(first, digits);
    if ("error" in target) return { ok: false, error: target.error };
    const jid = target.jid;
    // Show "typing…" briefly so the chat feels human.
    await first.sendPresenceUpdate("composing", jid).catch(() => undefined);
    await new Promise((r) => setTimeout(r, Math.min(1800, 400 + body.length * 8)));
    // The connection may have dropped during the pause: wait for the reconnect instead of failing on a dead connection.
    const sock = await liveSock(10_000);
    if (!sock) return { ok: false, error: NOT_CONNECTED };
    const res = await sock.sendMessage(jid, { text: body });
    if (res?.key?.id && res.message) remember(sentCache, res.key.id, res.message);
    void sock.sendPresenceUpdate("paused", jid).catch(() => undefined);
    return { ok: true, id: res?.key?.id ?? `qr-${Date.now()}` };
  } catch (e) {
    return { ok: false, error: redact((e as Error).message) };
  }
}

/** Auto-reconnect after a server restart if this device was already paired. */
export function autostartBridge() {
  if (activeProvider() === "qr" && existsSync(path.join(AUTH_DIR, "creds.json"))) {
    // Written on every start, so the history on the WhatsApp page shows how often the hosting restarts the app.
    void logEvent({ source: "whatsapp", event: "bridge_app_started", detail: `pid ${process.pid}` });
    void startBridge();
    startKeepAlive();
  }
}

/**
 * Some hosting plans stop a Node app that has had no visitors for a while, which would disconnect WhatsApp.
 * The app therefore opens its own public /health page every few minutes (only on a real https address).
 */
function startKeepAlive() {
  const url = process.env.SHOPIFY_APP_URL;
  if (!url || !/^https:\/\//.test(url)) return;
  const g2 = globalThis as unknown as { __waKeepAlive?: NodeJS.Timeout };
  if (g2.__waKeepAlive) return;
  g2.__waKeepAlive = setInterval(() => void fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined), 4 * 60_000);
  g2.__waKeepAlive.unref?.();
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
    const target = await resolveJid(sock, digits);
    if ("error" in target) return { ok: false, error: target.error };
    const res = await sock.sendMessage(target.jid, content);
    if (res?.key?.id && res.message) remember(sentCache, res.key.id, res.message);
    return { ok: true, id: res?.key?.id ?? `qr-${Date.now()}` };
  } catch (e) {
    return { ok: false, error: redact((e as Error).message) };
  }
}
