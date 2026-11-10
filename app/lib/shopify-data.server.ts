/* eslint-disable @typescript-eslint/no-explicit-any */
import { unauthenticated } from "../shopify.server";
import { productTerms } from "./intent";
import { logEvent } from "./log.server";
import { orderNameMatches, parseOrderRef } from "./order-ref";
import { explainShopifyError } from "./shopify-errors";
import { htmlToText } from "./product-summary";
import { normalizePhone, phoneSearchVariants, samePhone } from "./phone";
import { resolveTrackingUrl, type TrackingInfo } from "./tracking";

export class ShopifyError extends Error {}

type Gql = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Server-side Admin GraphQL call with throttle/5xx retry. The token never leaves the server. */
export async function gql(shop: string, query: string, variables: Gql = {}): Promise<Gql> {
  const { admin } = await unauthenticated.admin(shop);
  let lastErr = "unknown error";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await admin.graphql(query, { variables });
      const json = (await res.json()) as Gql;
      if (json.errors?.length) {
        lastErr = json.errors.map((e: Gql) => e.message).join("; ");
        if (json.errors.some((e: Gql) => e.extensions?.code === "THROTTLED")) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        break;
      }
      return json.data ?? {};
    } catch (e) {
      lastErr = e instanceof Response ? `HTTP ${e.status}` : String((e as Error)?.message ?? e);
      const retryable = e instanceof Response && (e.status === 429 || e.status >= 500);
      if (!retryable) break;
      await sleep(800 * (attempt + 1));
    }
  }
  await logEvent({ shop, source: "shopify", level: "error", event: "api_error", detail: lastErr });
  throw new ShopifyError(lastErr);
}

const esc = (s: string) => s.replace(/["\\:()*]/g, " ").trim();

// ---------- Orders ----------

const ORDER_FIELDS = `
  id name createdAt closedAt cancelledAt phone email statusPageUrl
  displayFinancialStatus displayFulfillmentStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  customer { id phone defaultPhoneNumber { phoneNumber } firstName lastName }
  shippingAddress { phone }
  billingAddress { phone }
  lineItems(first: 25) { nodes { title quantity sku } }
  fulfillments(first: 10) { status displayStatus estimatedDeliveryAt trackingInfo(first: 5) { company number url } }
`;

/** Injectable for tests: the function that runs one Admin GraphQL call. */
export type GqlRunner = (shop: string, query: string, variables?: Gql) => Promise<Gql>;

export type OrderSummary = {
  id: string;
  name: string;
  createdAt: string;
  cancelled: boolean;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  total: string | null;
  statusUrl: string | null;
  customerName: string | null;
  phones: string[];
  items: { title: string; quantity: number; sku: string | null }[];
  /** One entry per tracking number. `status` / `estimatedDeliveryAt` come from the fulfillment, only when Shopify has them. */
  tracking: (TrackingInfo & { resolvedUrl: string | null; status?: string | null; estimatedDeliveryAt?: string | null })[];
  /** Order archived/closed in Shopify (done). */
  closed?: boolean;
  /** Where the order lives. Shopify when not set. */
  source?: "shopify" | "ims";
};

export function mapOrder(o: Gql): OrderSummary {
  const tracking: OrderSummary["tracking"] = [];
  for (const f of o.fulfillments ?? []) {
    if (f?.displayStatus === "CANCELED") continue; // a cancelled shipment has no useful tracking
    for (const t of f.trackingInfo ?? []) {
      if (!t.number && !t.url) continue;
      tracking.push({
        ...t,
        resolvedUrl: resolveTrackingUrl(t),
        status: f.displayStatus ?? null,
        estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
      });
    }
  }
  const money = o.currentTotalPriceSet?.shopMoney;
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    cancelled: !!o.cancelledAt,
    closed: !!o.closedAt,
    financialStatus: o.displayFinancialStatus ?? null,
    fulfillmentStatus: o.displayFulfillmentStatus ?? null,
    total: money ? `${money.currencyCode} ${money.amount}` : null,
    statusUrl: o.statusPageUrl ?? null,
    customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || null,
    phones: [o.phone, o.customer?.phone, o.customer?.defaultPhoneNumber?.phoneNumber, o.shippingAddress?.phone, o.billingAddress?.phone].filter(Boolean),
    items: (o.lineItems?.nodes ?? []).map((l: Gql) => ({
      title: l.title,
      quantity: l.quantity,
      sku: l.sku ?? null,
    })),
    tracking,
  };
}

/** Ownership check: the order must carry the sender's own (normalised) phone number. */
export function orderBelongsTo(order: OrderSummary, e164: string): boolean {
  return order.phones.some((p) => samePhone(p, e164));
}

/** All orders carrying this phone number (customer record first, then orders that only have it on the order/address). */
export async function findOrdersByPhone(shop: string, e164: string, run: GqlRunner = gql): Promise<OrderSummary[]> {
  const found = new Map<string, OrderSummary>();
  const customerIds = new Set<string>();
  for (const v of phoneSearchVariants(e164)) {
    const data = await run(
      shop,
      `query($q: String!) { customers(first: 5, query: $q) { nodes { id phone defaultPhoneNumber { phoneNumber } } } }`,
      { q: `phone:${esc(v)}` },
    );
    for (const c of data.customers?.nodes ?? []) {
      if (samePhone(c.phone, e164) || samePhone(c.defaultPhoneNumber?.phoneNumber, e164)) customerIds.add(c.id);
    }
    if (customerIds.size) break;
  }
  for (const gid of customerIds) {
    const numeric = gid.split("/").pop();
    const data = await run(
      shop,
      `query($q: String!) { orders(first: 10, sortKey: CREATED_AT, reverse: true, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
      { q: `customer_id:${numeric}` },
    );
    for (const n of data.orders?.nodes ?? []) {
      const o = mapOrder(n);
      if (orderBelongsTo(o, e164)) found.set(o.id, o);
    }
  }
  if (!found.size) {
    // Guest checkouts: no customer record, the number is only on the order. Best effort, never fatal.
    for (const v of phoneSearchVariants(e164)) {
      try {
        const data = await run(
          shop,
          `query($q: String!) { orders(first: 10, sortKey: CREATED_AT, reverse: true, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
          { q: `phone:${esc(v)}` },
        );
        for (const n of data.orders?.nodes ?? []) {
          const o = mapOrder(n);
          if (orderBelongsTo(o, e164)) found.set(o.id, o);
        }
      } catch {
        break;
      }
      if (found.size) break;
    }
  }
  return [...found.values()];
}

const prefixCache = new Map<string, { prefix: string; at: number }>();

/** The store's order number prefix ("W" for #W1219), so a customer who types only "1219" still finds the order. */
async function shopOrderPrefix(shop: string, run: GqlRunner): Promise<string> {
  const hit = prefixCache.get(shop);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.prefix;
  let prefix = "";
  try {
    const data = await run(shop, `query { shop { orderNumberFormatPrefix } }`);
    prefix = String(data.shop?.orderNumberFormatPrefix ?? "").replace(/[^A-Za-z0-9]/g, "");
  } catch {
    /* without it a prefix-less number is searched as typed */
  }
  prefixCache.set(shop, { prefix, at: Date.now() });
  return prefix;
}

/**
 * Finds an order by its Shopify display NAME ("#W1219"), never by the internal numeric id.
 * Accepts "#W1219", "W1219", "w1219" and "1219" (the store prefix is added). Returns null when nothing matches exactly.
 */
export async function findOrderByNumber(shop: string, orderNumber: string, run: GqlRunner = gql): Promise<OrderSummary | null> {
  const ref = parseOrderRef(orderNumber);
  if (!ref) return null;
  const names = [ref.name];
  if (!ref.prefix) {
    const prefix = await shopOrderPrefix(shop, run);
    if (prefix) names.push(`#${prefix.toUpperCase()}${ref.digits}`);
  }
  const data = await run(
    shop,
    `query($q: String!) { orders(first: 5, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
    { q: names.map((n) => `name:${n}`).join(" OR ") },
  );
  const nodes: Gql[] = data.orders?.nodes ?? [];
  const hit = nodes.find((o) => orderNameMatches(String(o.name), ref));
  return hit ? mapOrder(hit) : null;
}

export async function getOrdersByIds(shop: string, ids: string[]): Promise<OrderSummary[]> {
  if (!ids.length) return [];
  const data = await gql(
    shop,
    `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } } }`,
    { ids },
  );
  return (data.nodes ?? []).filter(Boolean).map(mapOrder);
}

export async function listOrders(shop: string, opts: { after?: string | null; search?: string }) {
  const q = opts.search?.trim();
  const phone = normalizePhone(q ?? "");
  let query = "";
  if (q) {
    if (phone) query = `phone:${phoneSearchVariants(phone)[0]}`;
    else if (parseOrderRef(q)) query = `name:${parseOrderRef(q)!.name}`;
    else query = esc(q);
  }
  const data = await gql(
    shop,
    `query($after: String, $q: String) { orders(first: 20, after: $after, sortKey: CREATED_AT, reverse: true, query: $q) {
      nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    { after: opts.after ?? null, q: query || null },
  );
  return {
    orders: (data.orders?.nodes ?? []).map(mapOrder) as OrderSummary[],
    pageInfo: (data.orders?.pageInfo ?? { hasNextPage: false, endCursor: null }) as {
      hasNextPage: boolean;
      endCursor: string | null;
    },
  };
}

// ---------- Products ----------

const PRODUCT_FIELDS = `
  id title handle description descriptionHtml vendor status onlineStoreUrl productType tags totalInventory tracksInventory
  priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount } }
  compareAtPriceRange { minVariantCompareAtPrice { amount currencyCode } }
  featuredMedia { preview { image { url } } }
  variants(first: 5) { nodes { sku title price } }
`;

export type ProductSummary = {
  id: string;
  title: string;
  handle: string;
  description: string;
  /** Complete description, plain text (one line per paragraph / list item). */
  fullDescription: string;
  /** Original HTML description, used to read lists such as "What's in the box". */
  descriptionHtml: string;
  vendor: string;
  variants: { title: string; price: string | null; sku: string | null }[];
  url: string | null;
  imageUrl: string | null;
  price: string | null;
  /** Original ("compare-at") price, only when higher than the selling price. */
  compareAtPrice: string | null;
  /** Percent off versus compare-at, when there is one. */
  discountPercent: number | null;
  available: boolean;
  status: string;
  productType: string;
  tags: string[];
  skus: string[];
};

function money(amount: string | number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${currency} ${amount}`;
  }
}

function mapProduct(p: Gql): ProductSummary {
  const min = p.priceRangeV2?.minVariantPrice;
  const cmp = p.compareAtPriceRange?.minVariantCompareAtPrice;
  const hasCompare = !!min && !!cmp && Number(cmp.amount) > Number(min.amount);
  const available = p.tracksInventory === false ? true : (p.totalInventory ?? 0) > 0;
  return {
    id: p.id,
    title: p.title,
    handle: p.handle ?? "",
    description: String(p.description ?? "").slice(0, 300),
    fullDescription: p.descriptionHtml ? htmlToText(String(p.descriptionHtml)) : String(p.description ?? "").trim(),
    descriptionHtml: String(p.descriptionHtml ?? ""),
    vendor: String(p.vendor ?? ""),
    variants: (p.variants?.nodes ?? []).map((v: Gql) => ({
      title: String(v.title ?? ""),
      price: v.price != null && p.priceRangeV2?.minVariantPrice ? money(v.price, p.priceRangeV2.minVariantPrice.currencyCode) : null,
      sku: v.sku ?? null,
    })),
    url: p.onlineStoreUrl ?? null,
    imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    price: min ? money(min.amount, min.currencyCode) : null,
    compareAtPrice: hasCompare ? money(cmp.amount, cmp.currencyCode) : null,
    discountPercent: hasCompare ? Math.round((1 - Number(min.amount) / Number(cmp.amount)) * 100) : null,
    available,
    status: p.status,
    productType: p.productType ?? "",
    tags: p.tags ?? [],
    skus: (p.variants?.nodes ?? []).map((v: Gql) => v.sku).filter(Boolean),
  };
}

/** Customer-safe: ACTIVE and in stock. A storefront URL is added by withStoreUrl when Shopify has none. */
const sellable = (p: ProductSummary) => p.status === "ACTIVE" && p.available;

// onlineStoreUrl is null for products not published to the Online Store channel, so fall back to
// <primary domain>/products/<handle>.
const baseCache = new Map<string, { url: string; at: number }>();
async function storeBase(shop: string): Promise<string> {
  const hit = baseCache.get(shop);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.url;
  let url = `https://${shop}`;
  try {
    const data = await gql(shop, `query { shop { primaryDomain { url } } }`);
    url = String(data.shop?.primaryDomain?.url ?? url).replace(/\/$/, "");
  } catch {
    /* keep the myshopify.com fallback */
  }
  baseCache.set(shop, { url, at: Date.now() });
  return url;
}

async function withStoreUrl(shop: string, items: ProductSummary[]): Promise<ProductSummary[]> {
  if (!items.some((p) => !p.url && p.handle)) return items;
  const base = await storeBase(shop);
  // A bare myshopify.com storefront is usually password-protected/unpublished: show details instead of a dead link.
  if (base.endsWith(".myshopify.com")) return items;
  return items.map((p) => (p.url || !p.handle ? p : { ...p, url: `${base}/products/${p.handle}` }));
}

/**
 * Finds sellable products matching ANY of the words (title, type, tag, SKU), best match first.
 * One word is enough ("printer"); more matching words rank higher.
 */
export async function searchProducts(shop: string, term: string, limit = 5): Promise<ProductSummary[]> {
  const terms = productTerms(term);
  if (!terms.length) return [];
  const clause = terms.map((t) => `(title:*${t}* OR ${t}* OR tag:${t} OR product_type:${t} OR sku:${t})`).join(" OR ");
  const data = await gql(
    shop,
    `query($q: String!) { products(first: 40, sortKey: RELEVANCE, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`,
    { q: `status:active AND (${clause})` },
  );
  const score = (p: ProductSummary) => {
    const hay = `${p.title} ${p.productType} ${p.tags.join(" ")} ${p.skus.join(" ")}`.toLowerCase();
    const inTitle = p.title.toLowerCase();
    return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0) + (inTitle.includes(t) ? 1 : 0), 0);
  };
  const ranked = (data.products?.nodes ?? [])
    .map(mapProduct)
    .filter(sellable)
    .map((p: ProductSummary) => ({ p, s: score(p) }))
    .filter((x: { s: number }) => x.s > 0)
    .sort((x: { s: number }, y: { s: number }) => y.s - x.s)
    .slice(0, limit)
    .map((x: { p: ProductSummary }) => x.p);
  return withStoreUrl(shop, ranked);
}

export async function getProductsByIds(shop: string, ids: string[]): Promise<ProductSummary[]> {
  if (!ids.length) return [];
  const data = await gql(shop, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } } }`, { ids });
  const items: ProductSummary[] = (data.nodes ?? []).filter(Boolean).map(mapProduct).filter(sellable);
  return withStoreUrl(shop, items);
}

export async function recommendProducts(
  shop: string,
  base: ProductSummary,
  rule: "productType" | "tag",
  limit: number,
): Promise<ProductSummary[]> {
  const key = rule === "tag" ? base.tags[0] : base.productType;
  if (!key) return [];
  const q = `status:active AND ${rule === "tag" ? "tag" : "product_type"}:"${esc(key)}"`;
  const data = await gql(
    shop,
    `query($q: String!) { products(first: 15, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`,
    { q },
  );
  const recs: ProductSummary[] = (data.products?.nodes ?? [])
    .map(mapProduct)
    .filter((p: ProductSummary) => p.id !== base.id && sellable(p))
    .slice(0, limit);
  return withStoreUrl(shop, recs);
}

export async function listProducts(shop: string, opts: { after?: string | null; search?: string }) {
  const q = opts.search?.trim() ? esc(opts.search) : null;
  const data = await gql(
    shop,
    `query($after: String, $q: String) { products(first: 20, after: $after, query: $q) {
      nodes { ${PRODUCT_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    { after: opts.after ?? null, q },
  );
  return {
    products: (data.products?.nodes ?? []).map(mapProduct) as ProductSummary[],
    pageInfo: (data.products?.pageInfo ?? { hasNextPage: false, endCursor: null }) as {
      hasNextPage: boolean;
      endCursor: string | null;
    },
  };
}

// ---------- Connection diagnostics ----------

export const REQUIRED_SCOPES = ["read_orders", "read_customers", "read_products"];

type ConnectionTest =
  | { ok: true; shopName: string; domain: string; scopes: { scope: string; granted: boolean }[]; orders: { readable: number | null } }
  | { ok: false; error: string };

const testCache = new Map<string, { at: number; value: ConnectionTest }>();

/**
 * Can the app read what the bot needs? Checks the shop, the granted permissions AND a real order query with the
 * same fields the bot uses (phone, customer, tracking), because Shopify hides those unless Protected Customer Data
 * access is approved. Cached for a minute (the dashboard calls this on every refresh); `fresh` skips the cache.
 */
export async function testShopifyConnection(shop: string, fresh = false): Promise<ConnectionTest> {
  const hit = testCache.get(shop);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.value;
  let value: ConnectionTest;
  try {
    const data = await gql(
      shop,
      `query { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`,
    );
    const granted: string[] = (data.currentAppInstallation?.accessScopes ?? []).map((s: Gql) => s.handle);
    const has = (s: string) => granted.includes(s) || granted.includes(s.replace("read_", "write_"));
    const probe = await gql(shop, `query { orders(first: 1) { nodes { ${ORDER_FIELDS} } } ordersCount(limit: null) { count } }`);
    const count = Number(probe.ordersCount?.count);
    value = {
      ok: true,
      shopName: data.shop?.name as string,
      domain: data.shop?.myshopifyDomain as string,
      scopes: REQUIRED_SCOPES.map((s) => ({ scope: s, granted: has(s) })),
      orders: { readable: Number.isFinite(count) ? count : null },
    };
  } catch (e) {
    value = { ok: false, error: explainShopifyError(String((e as Error).message ?? e)) };
  }
  testCache.set(shop, { at: Date.now(), value });
  return value;
}
