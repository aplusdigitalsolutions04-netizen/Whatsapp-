/* eslint-disable @typescript-eslint/no-explicit-any */
import prisma from "../db.server";
import { logEvent } from "./log.server";
import { buildOrderNotices } from "./order-notice";
import { getSettings } from "./settings.server";
import { sendAndRecord } from "./whatsapp.server";

const PREFIX = "notify:";

/**
 * Sends the messages that are due for this order (confirmed / dispatched / delivered) to the customer's number.
 * Safe to call as often as you like: every message has a fixed key and is stored as "reply to <key>", and the database
 * allows only one message per key, so nothing is ever sent twice. Never throws: an order sync must not fail because of it.
 */
export async function notifyOrder(shop: string, node: any, opts: { windowMs?: number; latestOnly?: boolean } = {}): Promise<void> {
  try {
    const s = await getSettings(shop);
    if (!s.orderMessages) return;
    const { phone, notices } = buildOrderNotices(node, Date.now(), opts);
    if (!notices.length) return;
    if (!phone) {
      await logEvent({ shop, source: "bot", event: "order_notice_no_phone", detail: `${node?.name}: no valid phone number on the order` });
      return;
    }
    const gid = String(node.id);
    const name = String(node.shippingAddress?.name || node.customer?.firstName || "").trim() || null;
    const conv = await prisma.conversation.upsert({
      where: { shop_phone: { shop, phone } },
      create: { shop, phone, customerName: name, lastMessageAt: new Date() },
      update: {},
    });
    for (const n of notices) {
      const r = await sendAndRecord({ shop, conversationId: conv.id, to: phone, body: n.text, sender: "bot", inReplyTo: `${PREFIX}${gid}:${n.key}` });
      if (!r.ok && !r.skipped) await logEvent({ shop, source: "bot", level: "error", event: "order_notice_failed", detail: `${node?.name} ${n.kind}: ${r.error}` });
      else if (!r.skipped) await logEvent({ shop, source: "bot", event: "order_notice_sent", detail: `${node?.name} ${n.kind}` });
    }
  } catch (e) {
    await logEvent({ shop, source: "bot", level: "error", event: "order_notice_error", detail: (e as Error).message }).catch(() => undefined);
  }
}

const g = globalThis as unknown as { __noticeRetry?: { timer: NodeJS.Timeout | null; tries: Map<string, number> } };
const retry = (g.__noticeRetry ??= { timer: null, tries: new Map() });

/** Messages that could not be sent (for example WhatsApp was offline) are tried again every few minutes for 18 hours. */
export const CATCH_UP_MS = 18 * 3_600_000;

export async function retryFailedNotices(windowMs: number = CATCH_UP_MS) {
  const since = new Date(Date.now() - windowMs);
  const failed = await prisma.message.findMany({
    where: { inReplyTo: { startsWith: PREFIX }, status: "failed", createdAt: { gte: since } },
    include: { conversation: true },
    take: 20,
  });
  for (const m of failed) {
    if ((m.error ?? "").includes("24h")) continue; // the Cloud API needs an approved template here: trying again cannot help
    const n = (retry.tries.get(m.id) ?? 0) + 1;
    if (n > 5) continue;
    retry.tries.set(m.id, n);
    await sendAndRecord({ shop: m.conversation.shop, conversationId: m.conversationId, to: m.conversation.phone, body: m.body, sender: "bot", inReplyTo: m.inReplyTo! }).catch(() => undefined);
  }
}

export function startNoticeRetry() {
  if (retry.timer) return;
  retry.timer = setInterval(() => void retryFailedNotices().catch(() => undefined), 3 * 60_000);
  retry.timer.unref?.();
}

/**
 * After WhatsApp comes back: (1) send the order messages that failed while it was offline, (2) look at every order that
 * changed in the last 18 hours and send the ones that were never sent (the app may have been down, a webhook missed).
 * A message that was already sent is never sent again, because each one has a fixed key.
 */
export async function catchUpNotices(shop: string): Promise<number> {
  // The very first time this runs (right after the feature is installed) nothing is sent for older orders: the customers of
  // the last 18 hours were never promised these messages. From then on the catch-up works as described.
  const started = await prisma.activityLog.findFirst({ where: { shop, event: "order_notice_first_run" }, select: { id: true } });
  if (!started) {
    await logEvent({ shop, source: "bot", event: "order_notice_first_run", detail: "order messages start from now" });
    return 0;
  }
  const { gql } = await import("./shopify-data.server");
  const { ORDER_SHEET_FIELDS } = await import("./order-map");
  const since = new Date(Date.now() - CATCH_UP_MS).toISOString();
  let after: string | null = null;
  let seen = 0;
  for (let page = 0; page < 4; page++) {
    const data: any = await gql(
      shop,
      `query($after: String, $q: String) { orders(first: 50, after: $after, sortKey: UPDATED_AT, reverse: true, query: $q) { nodes { ${ORDER_SHEET_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { after, q: `updated_at:>=${since}` },
    );
    for (const node of data.orders?.nodes ?? []) {
      seen++;
      await notifyOrder(shop, node, { windowMs: CATCH_UP_MS, latestOnly: true });
    }
    const info = data.orders?.pageInfo;
    if (!info?.hasNextPage) break;
    after = info.endCursor;
  }
  return seen;
}

let catching = false;

/** Called by the WhatsApp bridge every time it (re)connects. */
export async function onWhatsAppConnected(): Promise<void> {
  if (catching) return;
  catching = true;
  try {
    await new Promise((r) => setTimeout(r, 20_000)); // let the connection settle first
    retry.tries.clear(); // attempts used up while WhatsApp was offline do not count
    await retryFailedNotices();
    const { resolveShop } = await import("./settings.server");
    const shop = await resolveShop();
    if (shop) {
      const n = await catchUpNotices(shop);
      await logEvent({ shop, source: "bot", event: "order_notice_catch_up", detail: `checked ${n} order(s) from the last 18 hours` });
    }
  } catch (e) {
    await logEvent({ source: "bot", level: "error", event: "order_notice_catch_up_failed", detail: (e as Error).message }).catch(() => undefined);
  } finally {
    catching = false;
  }
}
