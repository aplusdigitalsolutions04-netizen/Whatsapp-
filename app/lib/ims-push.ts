/* eslint-disable @typescript-eslint/no-explicit-any */
// Orders to the IMS portal, pure parts (no network, no database): the order's fields from Shopify and the JSON the IMS asked for
// (POST /api/external/v1/shopify/orders, "Shopify Order API Details"). Tested on their own.

export const IMS_ORDER_FIELDS = `
  id legacyResourceId name createdAt updatedAt cancelledAt cancelReason email phone note tags
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName lastName phone defaultPhoneNumber { phoneNumber } }
  shippingAddress { name firstName lastName address1 address2 city province zip phone }
  billingAddress { name firstName lastName address1 address2 city province zip phone }
  lineItems(first: 100) { nodes {
    title variantTitle quantity currentQuantity sku variant { id legacyResourceId sku }
    discountedUnitPriceSet { shopMoney { amount } }
    taxLines { rate ratePercentage }
  } }
  fulfillments(first: 10) { displayStatus trackingInfo(first: 5) { company number url } }
`;

export type ImsEvent = "order.created" | "order.updated" | "order.cancelled";

/** Which event a Shopify webhook topic means. A cancelled order is always "order.cancelled", whatever topic told us. */
export function imsEventFor(topic: string | null | undefined, node?: any): ImsEvent {
  const t = String(topic ?? "").toLowerCase().replace(/[_]/g, "/"); // "ORDERS_CREATE" and "orders/create" are the same topic
  if (node?.cancelledAt || t.startsWith("orders/cancel")) return "order.cancelled";
  return t.startsWith("orders/create") ? "order.created" : "order.updated";
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const money2 = (v: unknown): number => Math.round((num(v) ?? 0) * 100) / 100;
const text = (v: unknown) => String(v ?? "").trim();
const name = (a: any) => text(a?.name) || [a?.firstName, a?.lastName].map(text).filter(Boolean).join(" ");

function address(a: any) {
  if (!a) return {};
  return { name: name(a), address1: text(a.address1), address2: text(a.address2), city: text(a.city), state: text(a.province), pincode: text(a.zip), phone: text(a.phone) };
}

/** cod | prepaid | pending: how the customer pays. */
export function paymentMethod(node: any): "cod" | "prepaid" | "pending" {
  const gateways: string[] = node?.paymentGatewayNames ?? [];
  if (gateways.some((g) => /cod|cash on delivery/i.test(g))) return "cod";
  return ["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(node?.displayFinancialStatus) ? "prepaid" : "pending";
}

/** The items still in the order, as the IMS wants them. `sku` is empty when the product has none (the sender then refuses the order with a clear reason). */
export function imsItems(node: any) {
  const items: any[] = node?.lineItems?.nodes ?? [];
  return items
    .filter((i) => (i.currentQuantity ?? i.quantity) > 0)
    .map((i) => ({
      sku: text(i.sku) || text(i.variant?.sku),
      title: [text(i.title), i.variantTitle && i.variantTitle !== "Default Title" ? `(${text(i.variantTitle)})` : ""].filter(Boolean).join(" "),
      quantity: Number(i.currentQuantity ?? i.quantity ?? 0),
      price: money2(i.discountedUnitPriceSet?.shopMoney?.amount),
      variantId: text(i.variant?.legacyResourceId ?? String(i.variant?.id ?? "").split("/").pop()),
      gstRate: (i.taxLines ?? []).reduce((n: number, t: any) => n + (num(t?.ratePercentage) ?? (num(t?.rate) ?? 0) * 100), 0),
    }));
}

/** The order as the IMS asked for it (docs: "Format (JSON)"). Extra fields (fulfilment, tracking, cancelledAt) only add information. */
export function buildImsPayload(node: any, event: ImsEvent, shopDomain: string) {
  const money = node?.currentTotalPriceSet?.shopMoney;
  const ship = node?.shippingAddress;
  const customerName = name(ship) || [node?.customer?.firstName, node?.customer?.lastName].map(text).filter(Boolean).join(" ") || name(node?.billingAddress);
  const tracking = (node?.fulfillments ?? [])
    .filter((f: any) => f?.displayStatus !== "CANCELED")
    .flatMap((f: any) => f?.trackingInfo ?? [])
    .filter((t: any) => t?.number || t?.url)
    .map((t: any) => ({ company: text(t.company), number: text(t.number), url: text(t.url) }));
  return {
    event,
    shopDomain,
    shopifyOrderId: text(node?.legacyResourceId ?? String(node?.id ?? "").split("/").pop()),
    orderNumber: text(node?.name),
    createdAt: text(node?.createdAt),
    financialStatus: text(node?.displayFinancialStatus).toLowerCase(),
    paymentMethod: paymentMethod(node),
    totalPrice: money2(money?.amount),
    currency: text(money?.currencyCode) || "INR",
    customer: {
      name: customerName,
      phone: text(node?.phone) || text(node?.customer?.phone) || text(node?.customer?.defaultPhoneNumber?.phoneNumber) || text(ship?.phone) || text(node?.billingAddress?.phone),
      email: text(node?.email),
    },
    shippingAddress: address(ship),
    billingAddress: address(node?.billingAddress),
    items: imsItems(node),
    note: text(node?.note),
    tags: (node?.tags ?? []).map(text).filter(Boolean),
    fulfillmentStatus: text(node?.displayFulfillmentStatus).toLowerCase(),
    tracking,
    cancelledAt: node?.cancelledAt ? text(node.cancelledAt) : null,
  };
}

export type ImsPayload = ReturnType<typeof buildImsPayload>;

/** Why this order can never be accepted (so it is not retried for hours), or null when it is fine. The IMS requires shopDomain, shopifyOrderId and items[].sku. */
export function imsPayloadProblem(p: ImsPayload): string | null {
  if (!p.shopifyOrderId) return "the order has no Shopify id";
  if (!p.shopDomain) return "the shop domain is missing";
  const noSku = p.items.filter((i) => !i.sku);
  if (noSku.length) return `the IMS needs a SKU for every item; no SKU on: ${noSku.map((i) => i.title || "item").join(", ").slice(0, 160)}. Add the SKU in Shopify (Products → the variant), then press Retry.`;
  return null;
}

/** The IMS address must be https (http only on this computer for tests). Returns an error text or null. */
export function imsUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return "That is not a web address. Paste the full IMS address, e.g. https://ims.example.com/api/external/v1/shopify/orders";
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return "The IMS address must start with https://";
  if (!u.pathname || u.pathname === "/") return "The address is missing the path (it ends with /api/external/v1/shopify/orders).";
  return null;
}

/** How long to wait before the next try: 30 s, 1 min, 2, 4 ... up to 1 hour. */
export const retryDelayMs = (attempts: number) => Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
export const MAX_ATTEMPTS = 10;
