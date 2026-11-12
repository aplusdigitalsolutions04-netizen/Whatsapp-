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
export async function notifyOrder(shop: string, node: any): Promise<void> {
  try {
    const s = await getSettings(shop);
    if (!s.orderMessages) return;
    const { phone, notices } = buildOrderNotices(node);
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

/** Messages that could not be sent (for example WhatsApp was offline) are tried again every few minutes for 6 hours. */
export async function retryFailedNotices() {
  const since = new Date(Date.now() - 6 * 3_600_000);
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
