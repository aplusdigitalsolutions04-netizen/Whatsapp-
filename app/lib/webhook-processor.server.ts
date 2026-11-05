/* eslint-disable @typescript-eslint/no-explicit-any */
import prisma from "../db.server";
import { handleInbound, type InboundPayload } from "./bot.server";
import { logEvent, redact } from "./log.server";
import { resolveShop } from "./settings.server";

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

type Parsed =
  | { kind: "message"; key: string; payload: InboundPayload }
  | { kind: "status"; key: string; payload: { id: string; status: string; error?: string } };

/** Extracts only what's needed from Meta's payload (no raw body is stored). */
export function parseWhatsAppPayload(body: any): Parsed[] {
  const out: Parsed[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      if (!v) continue;
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) names.set(c.wa_id, c.profile?.name);
      for (const m of v.messages ?? []) {
        if (!m?.id || !m?.from) continue;
        out.push({
          kind: "message",
          key: m.id,
          payload: {
            id: m.id,
            from: m.from,
            type: m.type ?? "unknown",
            text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? "",
            name: names.get(m.from),
            timestamp: m.timestamp,
          },
        });
      }
      for (const st of v.statuses ?? []) {
        if (!st?.id || !st?.status) continue;
        out.push({
          kind: "status",
          key: `${st.id}:${st.status}`,
          payload: { id: st.id, status: st.status, error: st.errors?.[0]?.title },
        });
      }
    }
  }
  return out;
}

/** Stores the event (deduplicated). Returns the new event id, or null when it was a duplicate. */
export async function recordEvent(p: Parsed): Promise<string | null> {
  try {
    const ev = await prisma.webhookEvent.create({
      data: { eventKey: p.key, type: p.kind, payload: JSON.stringify(p.payload) },
    });
    return ev.id;
  } catch {
    await prisma.webhookEvent.updateMany({ where: { eventKey: p.key }, data: { duplicates: { increment: 1 } } });
    await logEvent({ source: "whatsapp", event: "duplicate_webhook", detail: p.key.slice(0, 40) });
    return null;
  }
}

export async function applyStatus(p: { id: string; status: string; error?: string }) {
  const msg = await prisma.message.findUnique({ where: { waMessageId: p.id } });
  if (!msg) return;
  if (p.status === "failed") {
    await prisma.message.update({ where: { id: msg.id }, data: { status: "failed", error: redact(p.error ?? "delivery failed") } });
    await logEvent({ source: "whatsapp", level: "error", event: "delivery_failed", detail: p.error });
    return;
  }
  if ((RANK[p.status] ?? -1) > (RANK[msg.status] ?? -1)) {
    await prisma.message.update({ where: { id: msg.id }, data: { status: p.status } });
  }
}

/** Runs (or re-runs) one stored event. Idempotent: bot replies are keyed by inbound id. */
export async function processEvent(eventId: string) {
  const ev = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.status === "processed") return;
  await prisma.webhookEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 } } });
  try {
    const payload = JSON.parse(ev.payload);
    if (ev.type === "status") {
      await applyStatus(payload);
    } else {
      const shop = await resolveShop();
      if (!shop) throw new Error("No Shopify store connected (install the app or set SHOPIFY_STORE_DOMAIN)");
      await handleInbound(shop, payload);
    }
    await prisma.webhookEvent.update({
      where: { id: ev.id },
      data: { status: "processed", error: null, processedAt: new Date(), payload: ev.type === "message" ? JSON.stringify({ id: payload.id }) : ev.payload },
    });
  } catch (e) {
    await prisma.webhookEvent.update({
      where: { id: ev.id },
      data: { status: "failed", error: redact((e as Error).message) },
    });
    await logEvent({ source: "whatsapp", level: "error", event: "event_failed", detail: (e as Error).message });
  }
}
