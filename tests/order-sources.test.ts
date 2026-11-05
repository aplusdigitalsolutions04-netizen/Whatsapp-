import { test } from "node:test";
import assert from "node:assert/strict";
import { imsConfig, imsLookup, mergeOrders, ownedBy, parseImsOrders } from "../app/lib/order-sources.ts";
import { DEFAULT_TEMPLATES, EDITABLE_TEMPLATES, TEMPLATES_HI } from "../app/lib/templates.ts";

const KEY = "k".repeat(32);
const sample = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  orders: [{ name: "1234", createdAt: "2026-11-01T10:30:00Z", status: "Dispatched", paymentStatus: "Paid", total: "Rs. 500", phones: ["+919876543210"], items: [{ title: "Printer", quantity: 2, sku: "HP-1" }], tracking: [{ company: "Delhivery", number: "DL1234567890", url: "http://not-https" }], ...extra }],
});
const shopifyOrder = (name: string, phone: string) => ({ id: `gid://shopify/Order/${name}`, name, createdAt: "2026-10-01T00:00:00Z", cancelled: false, financialStatus: "PAID", fulfillmentStatus: "FULFILLED", total: null, statusUrl: null, customerName: null, phones: [phone], items: [], tracking: [] });

test("IMS is only used when it is fully and safely configured", () => {
  assert.equal(imsConfig({}), null);
  assert.equal(imsConfig({ IMS_BASE_URL: "https://ims.example.com" }), null, "no key");
  assert.equal(imsConfig({ IMS_BASE_URL: "https://ims.example.com", IMS_LOOKUP_KEY: "short" }), null, "short key");
  assert.equal(imsConfig({ IMS_BASE_URL: "http://ims.example.com", IMS_LOOKUP_KEY: KEY }), null, "the key never travels over plain http");
  assert.equal(imsConfig({ IMS_BASE_URL: "not a url", IMS_LOOKUP_KEY: KEY }), null);
  assert.deepEqual(imsConfig({ IMS_BASE_URL: "https://ims.example.com/some/path", IMS_LOOKUP_KEY: KEY }), { baseUrl: "https://ims.example.com", path: "/api/orders/lookup", key: KEY });
  assert.ok(imsConfig({ IMS_BASE_URL: "http://localhost:4000", IMS_LOOKUP_KEY: KEY, IMS_LOOKUP_PATH: "orders" }));
});

test("IMS answer becomes a normal order; unsafe or broken parts are dropped", () => {
  const [o] = parseImsOrders(sample());
  assert.equal(o.name, "#1234");
  assert.equal(o.source, "ims");
  assert.equal(o.fulfillmentStatus, "Dispatched");
  assert.equal(o.items[0].quantity, 2);
  assert.equal(o.tracking[0].url, null, "a non-https tracking link is not forwarded to the customer");
  assert.deepEqual(parseImsOrders({ orders: [{ status: "x" }, null, "junk"] }), [], "rows without an order number are skipped");
  assert.deepEqual(parseImsOrders(null), []);
  assert.equal(parseImsOrders(sample({ status: "Cancelled" }))[0].cancelled, true);
  assert.deepEqual(parseImsOrders(sample({ phones: [] }))[0].phones, [], "no phones and no phone search: the order can never be released");
  assert.deepEqual(parseImsOrders(sample({ phones: [] }), "+919876543210")[0].phones, ["+919876543210"], "when the IMS filtered by phone, that phone is the owner");
});

test("asking the IMS: key header, query by phone or order, and every failure throws", async () => {
  const cfg = { baseUrl: "https://ims.example.com", path: "/api/orders/lookup", key: KEY };
  const seen: { url: string; key: string | null }[] = [];
  const ok = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), key: new Headers(init.headers).get("x-api-key") });
    return new Response(JSON.stringify(sample()), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await imsLookup(cfg, { phone: "+919876543210" }, ok)).length, 1);
  await imsLookup(cfg, { order: "#1234" }, ok);
  assert.equal(seen[0].url, "https://ims.example.com/api/orders/lookup?phone=%2B919876543210");
  assert.equal(seen[1].url, "https://ims.example.com/api/orders/lookup?order=1234");
  assert.equal(seen[0].key, KEY);

  const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
  await assert.rejects(imsLookup(cfg, { order: "1" }, status(401)), /HTTP 401/);
  await assert.rejects(imsLookup(cfg, { order: "1" }, status(500)), /HTTP 500/);
  await assert.rejects(imsLookup(cfg, { order: "1" }, (async () => { throw new Error("offline"); }) as unknown as typeof fetch), /offline/);
  await assert.rejects(imsLookup(cfg, { order: "1" }, (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch), /not valid/);
  await assert.rejects(imsLookup(cfg, { order: "1" }, (async () => new Response('{"ok":false}', { status: 200 })) as unknown as typeof fetch), /not valid/);
  assert.deepEqual(await imsLookup(cfg, { order: "9" }, (async () => new Response('{"ok":true,"orders":[]}', { status: 200 })) as unknown as typeof fetch), [], "an empty list is a real 'no order'");
});

test("both systems are combined once, and only the sender's own orders remain", () => {
  const me = "+919876543210";
  const shop = [shopifyOrder("#1001", me), shopifyOrder("#1002", "+911111111111")];
  const ims = parseImsOrders({ orders: [
    { name: "1001", phones: [me] }, // same order as in Shopify
    { name: "7001", phones: [me] },
    { name: "7002", phones: ["+912222222222"] },
  ] });
  const merged = mergeOrders(shop, ims);
  assert.deepEqual(merged.map((o) => o.name), ["#1001", "#1002", "#7001", "#7002"], "the duplicate #1001 is shown once");
  assert.equal(merged[0].source, "shopify");
  assert.deepEqual(ownedBy(merged, me).map((o) => `${o.name}:${o.source}`), ["#1001:shopify", "#7001:ims"]);
  assert.deepEqual(ownedBy(merged, "+913333333333"), [], "someone else's number gets nothing");
  assert.deepEqual(ownedBy(merged, "+919876543210").length, 2);
});

test("the 'no order found' reply exists in English and Hindi and can be edited in settings", () => {
  assert.match(DEFAULT_TEMPLATES.noOrderFound, /could not find any order/);
  assert.match(TEMPLATES_HI.noOrderFound, /ऑर्डर नहीं मिला/);
  assert.ok(EDITABLE_TEMPLATES.includes("noOrderFound"));
});
