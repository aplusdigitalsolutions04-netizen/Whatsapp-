/* eslint-disable @typescript-eslint/no-explicit-any */
// The messages JAZZ sends to a customer by itself when their order changes: confirmed, dispatched (with tracking), delivered.
// Pure functions (no network, no database), so they are easy to test. English only, short numbered points.
import { askOrderText } from "./order-confirm";
import { formatMoney } from "./money";
import { paymentType } from "./order-map";
import { normalizePhone } from "./phone";
import { clip, shortDate } from "./reply-format";
import { resolveTrackingUrl } from "./tracking";

export type Notice = { key: string; kind: "confirmed" | "confirm_ask" | "dispatched" | "delivered" | "cancelled"; text: string };

const MIN = 60_000;
/** An order is "new" for this long after it was placed. Older orders never get a "confirmed" message (a full sync must not message old customers). */
const NEW_ORDER_MS = 60 * MIN;
/** A shipment is "just dispatched" for this long after its tracking was added. */
const FRESH_SHIPMENT_MS = 2 * 60 * MIN;
const FRESH_DELIVERY_MS = 24 * 60 * MIN;

const when = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);

function itemsText(o: any): string {
  const items: any[] = (o.lineItems?.nodes ?? []).filter((i: any) => (i.currentQuantity ?? i.quantity ?? 0) > 0);
  const parts = items.map((i) => {
    const variant = i.variantTitle && i.variantTitle !== "Default Title" ? ` (${i.variantTitle})` : "";
    return `${i.title}${variant} × ${i.currentQuantity ?? i.quantity}`;
  });
  return clip(parts.join(", "), 220);
}

function firstName(o: any): string | null {
  const full = o.shippingAddress?.name || [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || o.billingAddress?.name || "";
  const first = String(full).trim().split(/\s+/)[0];
  return first && first.length <= 30 ? first : null;
}

/** The customer's WhatsApp number from the order (shipping, order, customer, billing phone, first valid one). */
export function orderPhone(o: any): string | null {
  for (const p of [o.shippingAddress?.phone, o.phone, o.customer?.defaultPhoneNumber?.phoneNumber, o.billingAddress?.phone]) {
    const n = normalizePhone(p);
    if (n) return n;
  }
  return null;
}

function point(n: number, label: string, value: string | null | undefined) {
  return value ? `${n}. ${label}: ${value}` : null;
}

const list = (rows: (string | null)[]) => {
  let n = 0;
  return rows.filter(Boolean).map((r) => r!.replace(/^\d+\./, `${++n}.`)).join("\n");
};

/** Which messages are due for this order right now. Each one has a stable key, so it is sent only once. */
export function buildOrderNotices(
  o: any,
  now: number = Date.now(),
  opts: { windowMs?: number; latestOnly?: boolean; askConfirmation?: boolean } = {},
): { phone: string | null; notices: Notice[] } {
  // Catching up after WhatsApp was offline: every "just now" window grows to windowMs, and with latestOnly an order only gets
  // the message for its newest stage (a delivered order is not told "confirmed" and "dispatched" now).
  const newMs = Math.max(NEW_ORDER_MS, opts.windowMs ?? 0);
  const shipMs = Math.max(FRESH_SHIPMENT_MS, opts.windowMs ?? 0);
  const deliveredMs = Math.max(FRESH_DELIVERY_MS, opts.windowMs ?? 0);
  const phone = orderPhone(o);
  const notices: Notice[] = [];
  if (!o) return { phone, notices };

  const name = firstName(o);
  const hello = name ? `, ${name}` : "";
  const orderName = String(o.name ?? "");
  const items = itemsText(o);
  const money = o.currentTotalPriceSet?.shopMoney;
  const total = money ? formatMoney(money.amount, money.currencyCode) : "";
  const pay = paymentType(o);
  const payment = pay === "COD" ? "Pay on delivery (COD)" : pay === "Prepaid" ? "Paid" : "Payment pending";
  const brand = "WERY";

  // 0. cancelled: one message, only right after the cancellation; a cancelled order gets no other message
  if (o.cancelledAt) {
    if (now - when(o.cancelledAt) < newMs) {
      notices.push({
        key: "cancelled",
        kind: "cancelled",
        text: [
          `Hi${hello}, this is JAZZ from ${brand}. Your order ${orderName} has been cancelled. ❌`,
          list([point(1, "Order Number", orderName), point(2, "Items", items), point(3, "Total", total)]),
          `${pay === "Prepaid" ? "Since you paid online, the refund goes back to your original payment method. 💳\n" : ""}If this was not expected or you need any help, just reply here and we will look into it. 💬`,
        ].join("\n\n"),
      });
    }
    return { phone, notices };
  }

  // 1. order confirmed
  if (when(o.createdAt) && now - when(o.createdAt) < newMs) {
    notices.push({
      key: "confirmed",
      kind: "confirmed",
      text: [
        `Hi${hello}! This is JAZZ from ${brand}. 👋\nYour order is confirmed. ✅`,
        list([point(1, "Order Number", orderName), point(2, "Items", items), point(3, "Total", total), point(4, "Payment", payment)]),
        `I will message you again as soon as it is dispatched. 📦\nThank you for shopping with ${brand}! 🙏`,
      ].join("\n\n"),
    });
    // 1b. the second message: "do you want this order?" (the customer's YES / NO is handled by order-confirm.server.ts)
    if (opts.askConfirmation) notices.push({ key: "confirm-ask", kind: "confirm_ask", text: askOrderText(orderName) });
  }

  const fulfillments: any[] = (o.fulfillments ?? []).filter((f: any) => f?.displayStatus !== "CANCELED");
  for (const f of fulfillments) {
    const tracks: any[] = (f.trackingInfo ?? []).filter((t: any) => t?.number);

    // 2. dispatched with a tracking id
    const touched = Math.max(when(f.createdAt), when(f.updatedAt));
    if (touched && now - touched < shipMs && f.displayStatus !== "DELIVERED" && !f.deliveredAt) {
      for (const t of tracks) {
        const link = resolveTrackingUrl({ company: t.company, number: t.number, url: t.url });
        notices.push({
          key: `dispatched:${t.number}`,
          kind: "dispatched",
          text: [
            `Good news${hello}! Your order ${orderName} has been dispatched. 🚚`,
            list([
              point(1, "Items", items),
              point(2, "Courier", t.company),
              point(3, "Tracking ID", t.number),
              point(4, "Track your parcel", link),
              point(5, "Expected Delivery", shortDate(f.estimatedDeliveryAt)),
            ]),
            link ? "Tap the link to see where your parcel is. 📍" : "Use the tracking ID on the courier's website to follow your parcel. 📍",
          ].join("\n\n"),
        });
      }
    }

    // 3. delivered
    const delivered = f.displayStatus === "DELIVERED" || !!f.deliveredAt;
    const fresh = f.deliveredAt ? now - when(f.deliveredAt) < deliveredMs : now - when(f.updatedAt) < shipMs;
    if (delivered && fresh) {
      notices.push({
        key: `delivered:${tracks[0]?.number ?? f.createdAt}`,
        kind: "delivered",
        text: [
          `Your order ${orderName} has been delivered. 🎉`,
          list([point(1, "Items", items), point(2, "Delivered on", shortDate(f.deliveredAt ?? f.updatedAt))]),
          `Thank you for shopping with ${brand}! 🙏\nIf anything is not right, just reply here and we will help. 💬`,
        ].join("\n\n"),
      });
    }
  }
  if (opts.latestOnly) {
    const rank = { confirmed: 1, confirm_ask: 1, dispatched: 2, delivered: 3, cancelled: 4 } as const;
    const top = Math.max(0, ...notices.map((n) => rank[n.kind]));
    return { phone, notices: notices.filter((n) => rank[n.kind] === top) };
  }
  return { phone, notices };
}

/** Delivery address of the order as one line (for the confirmation chat). */
export function orderAddress(o: any): string {
  const a = o?.shippingAddress ?? {};
  return [a.address1, a.address2, a.city, a.province, a.zip].filter(Boolean).join(", ");
}
