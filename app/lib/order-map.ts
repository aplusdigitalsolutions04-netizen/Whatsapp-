/* eslint-disable @typescript-eslint/no-explicit-any */
// Pure helpers: turn a Shopify Admin GraphQL order into the Order Calling Sheet's Shopify-managed fields.

export const ORDER_SHEET_FIELDS = `
  id legacyResourceId name createdAt updatedAt cancelledAt phone email tags
  displayFinancialStatus displayFulfillmentStatus returnStatus paymentGatewayNames
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName lastName defaultPhoneNumber { phoneNumber } }
  shippingAddress { name address1 address2 city province zip phone }
  billingAddress { name phone }
  shippingLine { originalPriceSet { shopMoney { amount } } }
  lineItems(first: 50) { nodes { title variantTitle quantity currentQuantity } }
  fulfillments(first: 10) { createdAt displayStatus deliveredAt trackingInfo(first: 3) { company number } }
`;

export type SheetStatus = "Cancelled" | "RTO" | "Delivered" | "Fulfilled" | "Unfulfilled";

/** The buckets used by the dashboard counters. Each order falls in exactly one status. */
export const SHEET_STATUSES: SheetStatus[] = ["Unfulfilled", "Fulfilled", "Delivered", "Cancelled", "RTO"];

const human = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/**
 * Status rules (highest priority first):
 *  Cancelled  - order has cancelledAt
 *  RTO        - tagged RTO, or Shopify return status RETURNED / IN_PROGRESS
 *  Delivered  - fully fulfilled AND every live fulfillment reports DELIVERED (fulfilled != delivered)
 *  Fulfilled  - fully fulfilled, not (yet) delivered
 *  Unfulfilled- everything else (not fulfilled, partially fulfilled, on hold, payment pending...)
 */
export function computeStatus(o: any): { status: SheetStatus; remarks: string } {
  const fulfillments: any[] = (o.fulfillments ?? []).filter((f: any) => f?.displayStatus !== "CANCELED");
  const tags: string[] = o.tags ?? [];
  const ful: string = o.displayFulfillmentStatus ?? "UNFULFILLED";
  const fin: string = o.displayFinancialStatus ?? "";
  const ret: string = o.returnStatus ?? "";

  if (o.cancelledAt) return { status: "Cancelled", remarks: "Cancelled" };
  if (tags.some((t) => /(^|[^a-z])rto([^a-z]|$)|return(ed)? to origin/i.test(t)) || ret === "RETURNED" || ret === "IN_PROGRESS") {
    return { status: "RTO", remarks: `RTO${ret ? ` (${human(ret)})` : ""}` };
  }
  const delivered = fulfillments.length > 0 && fulfillments.every((f) => f.displayStatus === "DELIVERED" || !!f.deliveredAt);
  if (ful === "FULFILLED") {
    if (delivered) return { status: "Delivered", remarks: "Delivered" };
    const last = fulfillments[fulfillments.length - 1]?.displayStatus;
    return { status: "Fulfilled", remarks: `Fulfilled${last && last !== "FULFILLED" ? ` · ${human(last)}` : ""}` };
  }
  const parts = ["Unfulfilled"];
  if (ful === "PARTIALLY_FULFILLED") parts[0] = "Partially fulfilled";
  else if (ful === "ON_HOLD") parts[0] = "On hold";
  else if (ful === "SCHEDULED") parts[0] = "Scheduled";
  if (fin === "PENDING" || fin === "AUTHORIZED") parts.push("Payment pending");
  return { status: "Unfulfilled", remarks: parts.join(" · ") };
}

const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");
const last10 = (s: string | null | undefined) => digits(s).slice(-10);

export type MappedOrder = {
  shopifyOrderId: string;
  orderName: string | null;
  orderDate: Date | null;
  customerName: string | null;
  productName: string | null;
  qty: number;
  amount: number | null;
  currency: string | null;
  paymentType: string | null;
  primaryMobile: string | null;
  altMobileShopify: string | null;
  fullAddress: string | null;
  city: string | null;
  state: string | null;
  pinCode: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  deliveryStatus: string | null;
  returnStatus: string | null;
  tags: string | null;
  cancelledAt: Date | null;
  status: SheetStatus;
  remarks: string;
  trackingNo: string | null;
  trackingCompany: string | null;
  dispatchDateShopify: Date | null;
  shippingCharge: number | null;
  shopifyUpdatedAt: Date | null;
};

export function paymentType(o: any): string {
  const gateways: string[] = o.paymentGatewayNames ?? [];
  if (gateways.some((g) => /cod|cash on delivery/i.test(g))) return "COD";
  if (["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(o.displayFinancialStatus)) return "Prepaid";
  return "Payment pending";
}

export function mapShopifyOrder(o: any): MappedOrder {
  const ship = o.shippingAddress ?? {};
  const { status, remarks } = computeStatus(o);
  const fulfillments: any[] = o.fulfillments ?? [];
  const tracking = fulfillments.flatMap((f) => f.trackingInfo ?? []).find((t: any) => t?.number);
  const items: any[] = o.lineItems?.nodes ?? [];
  const live = items.filter((i) => (i.currentQuantity ?? i.quantity) > 0);
  const phones = [ship.phone, o.phone, o.customer?.defaultPhoneNumber?.phoneNumber, o.billingAddress?.phone].filter(Boolean) as string[];
  const primary = phones[0] ?? null;
  const alt = phones.find((p) => last10(p) && last10(p) !== last10(primary)) ?? null;
  const dispatched = fulfillments.map((f) => f.createdAt).filter(Boolean).sort()[0];
  const money = o.currentTotalPriceSet?.shopMoney;
  const shipCharge = o.shippingLine?.originalPriceSet?.shopMoney?.amount;
  const deliveryStatus = fulfillments[fulfillments.length - 1]?.displayStatus ?? null;

  return {
    shopifyOrderId: String(o.legacyResourceId ?? String(o.id).split("/").pop()),
    orderName: o.name ?? null,
    orderDate: o.createdAt ? new Date(o.createdAt) : null,
    customerName: ship.name || [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || o.billingAddress?.name || null,
    productName: live.map((i) => (i.variantTitle && i.variantTitle !== "Default Title" ? `${i.title} (${i.variantTitle})` : i.title)).join(", ") || null,
    qty: live.reduce((n, i) => n + (i.currentQuantity ?? i.quantity ?? 0), 0),
    amount: money ? Number(money.amount) : null,
    currency: money?.currencyCode ?? null,
    paymentType: paymentType(o),
    primaryMobile: primary,
    altMobileShopify: alt,
    fullAddress: [ship.address1, ship.address2].filter(Boolean).join(", ") || null,
    city: ship.city ?? null,
    state: ship.province ?? null,
    pinCode: ship.zip ?? null,
    financialStatus: o.displayFinancialStatus ?? null,
    fulfillmentStatus: o.displayFulfillmentStatus ?? null,
    deliveryStatus,
    returnStatus: o.returnStatus ?? null,
    tags: (o.tags ?? []).join(", ") || null,
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    status,
    remarks,
    trackingNo: tracking?.number ?? null,
    trackingCompany: tracking?.company ?? null,
    dispatchDateShopify: dispatched ? new Date(dispatched) : null,
    shippingCharge: shipCharge != null ? Number(shipCharge) : null,
    shopifyUpdatedAt: o.updatedAt ? new Date(o.updatedAt) : null,
  };
}
