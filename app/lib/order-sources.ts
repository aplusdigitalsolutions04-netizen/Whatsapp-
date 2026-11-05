import type { OrderSummary } from "./shopify-data.server.ts";
import { samePhone } from "./phone.ts";
import { resolveTrackingUrl } from "./tracking.ts";

// Orders can live in Shopify and in the IMS (inventory system). This file knows how to talk to the IMS and how to
// combine both answers. It has no dependency on the app's login or database, so it can be tested on its own.

export type ImsConfig = { baseUrl: string; path: string; key: string };

/** The IMS connection, or null when it is not set up (then the bot only uses Shopify). */
export function imsConfig(env: Record<string, string | undefined> = process.env): ImsConfig | null {
  const base = (env.IMS_BASE_URL ?? "").trim();
  const key = (env.IMS_LOOKUP_KEY ?? "").trim();
  if (!base || key.length < 16) return null;
  try {
    const u = new URL(base);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null; // the key must never travel in clear text
    const path = (env.IMS_LOOKUP_PATH ?? "/api/orders/lookup").trim();
    return { baseUrl: u.origin, path: path.startsWith("/") ? path : `/${path}`, key };
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Turns the IMS answer into the same shape the bot already uses for Shopify orders. Bad rows are skipped, never guessed. */
export function parseImsOrders(json: unknown, assumePhone?: string): OrderSummary[] {
  const out: OrderSummary[] = [];
  for (const raw of arr(rec(json).orders).slice(0, 10)) {
    const o = rec(raw);
    const name = str(o.name) || str(o.orderNumber) || str(o.id);
    if (!name) continue;
    const phones = arr(o.phones).map(str).filter(Boolean);
    const single = str(o.phone);
    if (single) phones.push(single);
    if (phones.length === 0 && assumePhone) phones.push(assumePhone); // the IMS already filtered by this phone
    const created = new Date(str(o.createdAt) || Date.now());
    out.push({
      id: `ims:${name}`,
      name: name.startsWith("#") ? name : `#${name}`,
      createdAt: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
      cancelled: o.cancelled === true || /^cancel/i.test(str(o.status)),
      financialStatus: str(o.paymentStatus) || null,
      fulfillmentStatus: str(o.status) || null,
      total: str(o.total) || null,
      statusUrl: /^https:\/\//.test(str(o.statusUrl)) ? str(o.statusUrl) : null,
      customerName: str(o.customerName) || null,
      phones,
      items: arr(o.items).slice(0, 20).map((i) => ({ title: str(rec(i).title) || "Item", quantity: Math.max(1, Math.round(Number(rec(i).quantity) || 1)), sku: str(rec(i).sku) || null })),
      tracking: arr(o.tracking).slice(0, 5).map((t) => {
        const r = rec(t);
        const info = { company: str(r.company) || null, number: str(r.number) || null, url: /^https:\/\//.test(str(r.url)) ? str(r.url) : null };
        return { ...info, resolvedUrl: resolveTrackingUrl(info) };
      }),
      source: "ims",
    });
  }
  return out;
}

type Fetch = typeof fetch;

/** Asks the IMS for orders by phone or by order number. Throws on any network or HTTP problem (the caller decides what that means). */
export async function imsLookup(cfg: ImsConfig, by: { phone: string } | { order: string }, fetchFn: Fetch = fetch): Promise<OrderSummary[]> {
  const url = new URL(cfg.path, cfg.baseUrl);
  if ("phone" in by) url.searchParams.set("phone", by.phone);
  else url.searchParams.set("order", by.order.replace(/\D/g, ""));
  const res = await fetchFn(url, { headers: { "x-api-key": cfg.key, Accept: "application/json" }, signal: AbortSignal.timeout(6000), redirect: "error" });
  if (!res.ok) throw new Error(`IMS answered HTTP ${res.status}`);
  const json = (await res.json().catch(() => null)) as unknown;
  if (!json || rec(json).ok === false) throw new Error("IMS answer was not valid");
  return parseImsOrders(json, "phone" in by ? by.phone : undefined);
}

const digits = (name: string) => name.replace(/\D/g, "");

/** Shopify first, then IMS. An IMS order with the same number as a Shopify order is the same order, so it is shown once. */
export function mergeOrders(shopify: OrderSummary[], ims: OrderSummary[]): OrderSummary[] {
  const have = new Set(shopify.map((o) => digits(o.name)));
  const extra = ims.filter((o) => !have.has(digits(o.name)));
  return [...shopify.map((o) => ({ ...o, source: o.source ?? ("shopify" as const) })), ...extra];
}

export const ownedBy = (orders: OrderSummary[], phone: string) => orders.filter((o) => o.phones.some((p) => samePhone(p, phone)));
