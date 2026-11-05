/* eslint-disable @typescript-eslint/no-explicit-any */
import prisma from "../db.server";
import { logEvent, redact } from "./log.server";

const GRAPH = "https://graph.facebook.com/v21.0";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export function whatsappConfig() {
  return {
    accessToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: !!process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: !!process.env.WHATSAPP_APP_SECRET,
  };
}

export function whatsappConfigured() {
  const c = whatsappConfig();
  return c.accessToken && c.phoneNumberId;
}

type SendResult = { ok: true; id: string } | { ok: false; error: string; retryable: boolean };

async function graphPost(path: string, body: unknown): Promise<SendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    return { ok: false, error: "WhatsApp Cloud API is not configured", retryable: false };
  }
  let last: SendResult = { ok: false, error: "unknown", retryable: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${GRAPH}/${phoneId}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok && json.messages?.[0]?.id) return { ok: true, id: json.messages[0].id };
      const retryable = res.status === 429 || res.status >= 500;
      last = {
        ok: false,
        error: redact(`HTTP ${res.status}: ${json.error?.message ?? "send failed"} (code ${json.error?.code ?? "?"})`),
        retryable,
      };
      if (!retryable) return last;
    } catch (e) {
      last = { ok: false, error: redact(`network: ${(e as Error).message}`), retryable: true };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

/** Photos/files can only be sent through the QR (WhatsApp Web) connection. */
export async function canSendMedia(): Promise<boolean> {
  const { activeProvider } = await import("./bridge.server");
  return activeProvider() === "qr";
}

export const insideServiceWindow = (lastInboundAt: Date | null) =>
  !!lastInboundAt && Date.now() - lastInboundAt.getTime() < WINDOW_MS;

/**
 * Sends a free-form text and records it. `inReplyTo` makes the bot reply idempotent:
 * the DB allows at most one outbound row per inbound id, so webhook retries can't double-send.
 */
export async function sendAndRecord(args: {
  shop: string;
  conversationId: string;
  to: string;
  body: string;
  sender: "bot" | "agent";
  inReplyTo?: string;
  /** Attachment already saved by saveMedia(); `body` is then used as the caption. */
  media?: { kind: string; mime: string; name?: string; file: string };
}): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const { conversationId, to, body, sender, inReplyTo, shop, media } = args;
  let row = inReplyTo
    ? await prisma.message.findUnique({ where: { inReplyTo } })
    : null;
  if (row && row.status !== "failed") return { ok: true, skipped: true };

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!row) {
    try {
      row = await prisma.message.create({
        data: {
          conversationId, direction: "out", sender, body, inReplyTo: inReplyTo ?? null, status: "queued",
          mediaKind: media?.kind ?? null, mediaMime: media?.mime ?? null, mediaName: media?.name ?? null, mediaFile: media?.file ?? null,
        },
      });
    } catch {
      return { ok: true, skipped: true }; // lost a race with a concurrent attempt
    }
  }

  const fail = async (error: string) => {
    await prisma.message.update({ where: { id: row!.id }, data: { status: "failed", error } });
    await logEvent({ shop, source: "whatsapp", level: "error", event: "send_failed", detail: error });
    return { ok: false, error };
  };

  // Dynamic import: bridge.server -> webhook-processor -> bot -> this file would be circular.
  const { activeProvider, bridgeSendText, bridgeSendMedia } = await import("./bridge.server");
  let result: SendResult;
  if (activeProvider() === "qr") {
    const r = media ? await bridgeSendMedia(to, media, body) : await bridgeSendText(to, body);
    result = r.ok ? r : { ok: false, error: r.error, retryable: true };
  } else {
    if (media) return fail("Sending files needs the QR (WhatsApp Web) connection");
    if (!insideServiceWindow(conv?.lastInboundAt ?? null)) {
      return fail("Outside 24h customer service window; an approved template message is required");
    }
    result = await graphPost("messages", {
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "text",
      text: { body, preview_url: true },
    });
  }
  if (!result.ok) return fail(result.error);

  await prisma.message.update({
    where: { id: row.id },
    data: { status: "sent", waMessageId: result.id, error: null },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  return { ok: true };
}

export async function whatsappDiagnostics() {
  const cfg = whatsappConfig();
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    return { ok: false as const, error: "Access token or phone number ID missing", config: cfg };
  }
  try {
    const res = await fetch(
      `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
      {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false as const, error: redact(json.error?.message ?? `HTTP ${res.status}`), config: cfg };
    }
    return {
      ok: true as const,
      config: cfg,
      displayNumber: json.display_phone_number as string,
      verifiedName: json.verified_name as string,
      quality: json.quality_rating as string | undefined,
    };
  } catch (e) {
    return { ok: false as const, error: redact((e as Error).message), config: cfg };
  }
}
