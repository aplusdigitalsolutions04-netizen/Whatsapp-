import { logEvent } from "./log.server";
import { imsConfig, imsLookup, mergeOrders, ownedBy } from "./order-sources";
import { findOrderByNumber, findOrdersByPhone, getOrdersByIds, type OrderSummary } from "./shopify-data.server";

// One place that asks Shopify AND the IMS. Rule: an empty answer only counts as "no order" when every source really answered.
// If a source failed we throw, so the customer gets "please try again" instead of a wrong "you have no order".

const noteFail = (shop: string, source: string, e: unknown) =>
  logEvent({ shop, source: "bot", level: "error", event: "order_lookup_failed", detail: `${source}: ${(e as Error)?.message ?? e}` });

async function both<T>(shop: string, shopify: () => Promise<T>, ims: (() => Promise<T>) | null, empty: (v: T) => boolean): Promise<{ shopify: T | null; ims: T | null }> {
  const [a, b] = await Promise.allSettled([shopify(), ims ? ims() : Promise.resolve(null as T | null)]);
  if (a.status === "rejected") await noteFail(shop, "shopify", a.reason);
  if (b.status === "rejected") await noteFail(shop, "ims", b.reason);
  const sFail = a.status === "rejected";
  const iFail = b.status === "rejected";
  const sv = a.status === "fulfilled" ? a.value : null;
  const iv = b.status === "fulfilled" ? b.value : null;
  const found = (sv !== null && !empty(sv)) || (iv !== null && !empty(iv));
  if (!found && (sFail || iFail)) throw (sFail ? (a as PromiseRejectedResult).reason : (b as PromiseRejectedResult).reason);
  return { shopify: sv, ims: iv };
}

/** All orders placed with this phone number, from both systems. */
export async function findOrdersEverywhere(shop: string, phone: string): Promise<OrderSummary[]> {
  const cfg = imsConfig();
  const r = await both<OrderSummary[]>(shop, () => findOrdersByPhone(shop, phone), cfg ? () => imsLookup(cfg, { phone }) : null, (v) => v.length === 0);
  return ownedBy(mergeOrders(r.shopify ?? [], r.ims ?? []), phone);
}

/** The order with this number, from either system, only if it belongs to this phone number. */
export async function findOrderEverywhere(shop: string, number: string, phone: string): Promise<OrderSummary | null> {
  const cfg = imsConfig();
  const r = await both<OrderSummary[]>(
    shop,
    async () => {
      const o = await findOrderByNumber(shop, number);
      return o ? [o] : [];
    },
    cfg ? () => imsLookup(cfg, { order: number }) : null,
    (v) => v.length === 0,
  );
  return ownedBy(mergeOrders(r.shopify ?? [], r.ims ?? []), phone)[0] ?? null;
}

/** Orders picked from a list: Shopify ids and `ims:#1234` ids can be mixed. */
export async function getOrdersEverywhere(shop: string, ids: string[]): Promise<OrderSummary[]> {
  const shopifyIds = ids.filter((i) => !i.startsWith("ims:"));
  const imsNames = ids.filter((i) => i.startsWith("ims:")).map((i) => i.slice(4));
  const cfg = imsConfig();
  const out: OrderSummary[] = [];
  if (shopifyIds.length) out.push(...(await getOrdersByIds(shop, shopifyIds)));
  if (cfg) for (const n of imsNames) out.push(...(await imsLookup(cfg, { order: n })).filter((o) => o.name.replace(/\D/g, "") === n.replace(/\D/g, "")));
  return out;
}
