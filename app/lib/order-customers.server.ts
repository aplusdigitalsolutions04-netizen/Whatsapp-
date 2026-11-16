import prisma from "../db.server";

// "Is this WhatsApp number one of our order customers?" A number counts when it is on any order (order, shipping, customer or
// billing phone, or an alternate number an employee typed into the Order Sheet) or when JAZZ already sent it an order message.

const digits10 = (v: string | null | undefined) => {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};

type Cache = { at: number; set: Set<string> };
const g = globalThis as unknown as { __orderNumbers?: Map<string, Cache> };
const caches = (g.__orderNumbers ??= new Map());

const FULL_MS = 5 * 60_000; // the whole list is reloaded at most this often
const MISS_MS = 20_000; // an unknown number may belong to an order that was just created: reload if the list is older than this

async function load(shop: string): Promise<Set<string>> {
  // Only real Shopify orders count: rows an employee added by hand ("manual") are not orders from the store.
  const rows = await prisma.orderSheet.findMany({ where: { shop, isManual: false }, select: { primaryMobile: true, altMobileShopify: true, altMobile: true } });
  const set = new Set<string>();
  for (const r of rows) for (const v of [r.primaryMobile, r.altMobileShopify, r.altMobile]) {
    const d = digits10(v);
    if (d) set.add(d);
  }
  caches.set(shop, { at: Date.now(), set });
  return set;
}

export async function isOrderCustomer(shop: string, phone: string): Promise<boolean> {
  const key = digits10(phone);
  if (!key) return false;
  // JAZZ sent this number an order message: it is an order customer by definition (also covers an order not synced to the sheet yet).
  const noticed = await prisma.orderConfirmation.findFirst({ where: { shop, phone }, select: { id: true } });
  if (noticed) return true;
  const c = caches.get(shop);
  if (c && Date.now() - c.at < FULL_MS && c.set.has(key)) return true;
  if (c && Date.now() - c.at < MISS_MS) return false;
  return (await load(shop)).has(key);
}

/** For tests: forget the remembered list. */
export const forgetOrderNumbers = () => caches.clear();
