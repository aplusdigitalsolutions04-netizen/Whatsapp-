import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { activeProvider, bridgeSendText, bridgeStatus } from "../lib/bridge.server";
import { logEvent } from "../lib/log.server";
import { normalizePhone } from "../lib/phone";
import { rateLimited } from "../lib/rate-limit.server";

// The IMS (inventory system) sends WhatsApp messages to staff through the number this app keeps connected.
// This route is NOT behind the Shopify login. Its only protection is the secret key in IMS_API_KEY.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** Constant-time key check. Refuses to run at all when the key is missing or short. */
function keyOk(request: Request): boolean {
  const expected = process.env.IMS_API_KEY;
  if (!expected || expected.length < 24) return false;
  const given = Buffer.from(request.headers.get("x-api-key") ?? "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** GET /api/send: is WhatsApp connected? */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!keyOk(request)) return json({ ok: false, error: "Unauthorized" }, 401);
  const s = bridgeStatus();
  return json({ ok: true, provider: activeProvider(), connected: activeProvider() === "qr" && s.state === "connected", state: s.state, number: s.number });
};

/** POST /api/send  { "to": "9876543210", "text": "...", "ref": "Billing - Contract 123" } */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!keyOk(request)) return json({ ok: false, error: "Unauthorized" }, 401);

  // Throttle: protects the number from being flooded (WhatsApp can ban a number that sends too much).
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(`ims-send:${ip}`, 60, 60_000) || rateLimited("ims-send:all", 120, 60_000)) {
    return json({ ok: false, error: "Too many messages, slow down" }, 429);
  }

  let body: { to?: string; text?: string; ref?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }

  const phone = normalizePhone(body?.to);
  if (!phone) return json({ ok: false, error: "Invalid phone number" }, 400);
  const text = String(body?.text ?? "").trim();
  if (!text || text.length > 1500) return json({ ok: false, error: "Text is empty or too long (max 1500)" }, 400);
  const ref = String(body?.ref ?? "").slice(0, 80);

  // Free text to anyone is only allowed by WhatsApp inside the QR (WhatsApp Web) connection.
  if (activeProvider() !== "qr") return json({ ok: false, error: "This route needs the QR (WhatsApp Web) connection" }, 501);

  const r = await bridgeSendText(phone, text);
  await logEvent({
    source: "whatsapp",
    event: "ims_send",
    level: r.ok ? "info" : "error",
    // never write the whole number or the text into the log
    detail: `${ref || "message"} -> ${phone.slice(0, -4)}****${r.ok ? "" : `: ${r.error}`}`,
  });
  if (!r.ok) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, id: r.id });
};
