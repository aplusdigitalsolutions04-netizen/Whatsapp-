import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { activeProvider } from "../lib/bridge.server";
import { logEvent } from "../lib/log.server";
import { rateLimited } from "../lib/rate-limit.server";
import { verifyMetaSignature } from "../lib/signature";
import { parseWhatsAppPayload, processEvent, recordEvent } from "../lib/webhook-processor.server";

// Meta's one-time webhook verification handshake.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (
    expected &&
    url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === expected
  ) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Only one provider may answer customers; ignore Cloud API traffic while the QR bridge is active.
  if (activeProvider() === "qr") return new Response("Cloud API webhook disabled (QR provider active)", { status: 200 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(`wa:${ip}`, 600, 60_000)) return new Response("Too many requests", { status: 429 });

  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    await logEvent({ source: "whatsapp", level: "error", event: "webhook_rejected", detail: "WHATSAPP_APP_SECRET not set" });
    return new Response("Webhook not configured", { status: 500 });
  }

  const raw = await request.text();
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
    await logEvent({ source: "whatsapp", level: "error", event: "webhook_rejected", detail: "invalid signature" });
    return new Response("Invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const ids: string[] = [];
  for (const parsed of parseWhatsAppPayload(body)) {
    const id = await recordEvent(parsed);
    if (id) ids.push(id);
  }
  // Acknowledge fast (Meta retries slow responders); process after responding.
  void (async () => {
    for (const id of ids) await processEvent(id);
  })();
  return new Response("OK", { status: 200 });
};
