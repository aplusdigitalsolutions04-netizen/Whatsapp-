/* eslint-disable @typescript-eslint/no-explicit-any */
import { BILLING_FIELDS, MAX_BILLING_ORDERS, orderToRows, parseOrderIds, type BillingRow } from "./billing-data";
import { orderNameMatches, parseOrderRef, type OrderRef } from "./order-ref";
import { gql, shopOrderPrefix, type GqlRunner } from "./shopify-data.server";

export { MAX_BILLING_ORDERS };
const CHUNK = 20; // order names per Shopify search

export type BillingResult = {
  rows: BillingRow[];
  /** Order names found in Shopify, in the order the person typed them. */
  found: string[];
  /** Typed ids that look like an order id but Shopify has no order with that number (or the order is too old for this app to read). */
  missing: string[];
  /** Typed text that is not an order id at all. */
  invalid: string[];
  /** More ids than the page handles at once; these were left out. */
  skipped: string[];
};

/** Fetches ONLY the orders typed by the person (never the whole store) and turns each item into a billing row. */
export async function fetchBillingOrders(shop: string, text: string, run: GqlRunner = gql): Promise<BillingResult> {
  const typed = parseOrderIds(text);
  const all: { typed: string; ref: OrderRef }[] = [];
  const invalid: string[] = [];
  for (const t of typed) {
    const ref = parseOrderRef(t);
    if (ref) all.push({ typed: t, ref });
    else invalid.push(t);
  }
  const wanted = all.slice(0, MAX_BILLING_ORDERS);
  const skipped = all.slice(MAX_BILLING_ORDERS).map((w) => w.typed);

  // "1219" without the store letter: also search "#W1219" (the store's prefix), like the bot does.
  const prefix = wanted.some((w) => !w.ref.prefix) ? await shopOrderPrefix(shop, run) : "";
  const nodes: any[] = [];
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const names = new Set<string>();
    for (const { ref } of wanted.slice(i, i + CHUNK)) {
      names.add(ref.name);
      if (!ref.prefix && prefix) names.add(`#${prefix.toUpperCase()}${ref.digits}`);
    }
    const data = await run(shop, `query($q: String!) { orders(first: 100, query: $q) { nodes { ${BILLING_FIELDS} } } }`, {
      q: [...names].map((n) => `name:${n}`).join(" OR "),
    });
    nodes.push(...(data.orders?.nodes ?? []));
  }

  const rows: BillingRow[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  const used = new Set<string>();
  for (const { typed: t, ref } of wanted) {
    const hit = nodes.find((n) => orderNameMatches(String(n.name), ref));
    if (!hit) {
      missing.push(t);
      continue;
    }
    if (used.has(hit.id)) continue; // "1219" and "#W1219" typed together: one order, one set of rows
    used.add(hit.id);
    found.push(String(hit.name));
    rows.push(...orderToRows(hit));
  }
  return { rows, found, missing, invalid, skipped };
}
