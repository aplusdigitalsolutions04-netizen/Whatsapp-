/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { buildImsPayload, imsEventFor, imsPayloadProblem, imsUrlProblem, MAX_ATTEMPTS, paymentMethod, retryDelayMs } from "../app/lib/ims-push.ts";
import { closeApp, loadApp } from "./helpers/load-app.ts";

const SHOP = "ims-push-test.invalid"; // isolated shop; its rows are removed afterwards
const URL_OK = "https://ims.example.com/api/external/v1/shopify/orders";
after(async () => {
  await prisma.imsPush.deleteMany({ where: { shop: SHOP } });
  await prisma.imsConfig.deleteMany({ where: { shop: SHOP } });
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  await closeApp();
});

const node = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/5123456789", legacyResourceId: "5123456789", name: "#1234", createdAt: "2026-11-25T05:00:00Z", cancelledAt: null,
  email: "asha@example.com", phone: "+919876543210", note: "Call before delivery", tags: ["vip", "cod"],
  displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", paymentGatewayNames: ["razorpay"],
  currentTotalPriceSet: { shopMoney: { amount: "4500.0", currencyCode: "INR" } },
  customer: { firstName: "Asha", lastName: "Kumar", phone: null },
  shippingAddress: { name: "Asha Kumar", address1: "12 MG Road", address2: "Flat 4", city: "Pune", province: "Maharashtra", zip: "411001", phone: "+919876543210" },
  billingAddress: { name: "Asha Kumar", address1: "12 MG Road", city: "Pune", province: "Maharashtra", zip: "411001" },
  lineItems: { nodes: [
    { title: "HP LaserJet 1008w", variantTitle: "Default Title", quantity: 2, currentQuantity: 2, sku: "HP-1008W", variant: { id: "gid://shopify/ProductVariant/777", legacyResourceId: "777", sku: "HP-1008W" }, discountedUnitPriceSet: { shopMoney: { amount: "2250.00" } }, taxLines: [{ rate: 0.18, ratePercentage: 18 }] },
    { title: "Removed", variantTitle: null, quantity: 1, currentQuantity: 0, sku: "X", discountedUnitPriceSet: { shopMoney: { amount: "1" } }, taxLines: [] },
  ] },
  fulfillments: [{ displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "Delhivery", number: "DL123", url: "https://www.delhivery.com/track/DL123" }] }],
  ...over,
});

test("IMS payload: exactly the format the IMS asked for", () => {
  const p: any = buildImsPayload(node(), "order.created", "wery-in.myshopify.com");
  assert.equal(p.event, "order.created");
  assert.equal(p.shopDomain, "wery-in.myshopify.com");
  assert.equal(p.shopifyOrderId, "5123456789", "the number, not the gid");
  assert.equal(p.orderNumber, "#1234");
  assert.equal(p.createdAt, "2026-11-25T05:00:00Z");
  assert.equal(p.financialStatus, "paid");
  assert.equal(p.paymentMethod, "prepaid");
  assert.equal(p.totalPrice, 4500);
  assert.equal(p.currency, "INR");
  assert.deepEqual(p.customer, { name: "Asha Kumar", phone: "+919876543210", email: "asha@example.com" });
  assert.deepEqual(p.shippingAddress, { name: "Asha Kumar", address1: "12 MG Road", address2: "Flat 4", city: "Pune", state: "Maharashtra", pincode: "411001", phone: "+919876543210" });
  assert.equal(p.billingAddress.pincode, "411001");
  assert.deepEqual(p.items, [{ sku: "HP-1008W", title: "HP LaserJet 1008w", quantity: 2, price: 2250, variantId: "777", gstRate: 18 }], "a removed item is left out; price is per piece");
  assert.equal(p.note, "Call before delivery");
  assert.deepEqual(p.tags, ["vip", "cod"]);
  assert.deepEqual(p.tracking, [{ company: "Delhivery", number: "DL123", url: "https://www.delhivery.com/track/DL123" }]);
  assert.equal(p.fulfillmentStatus, "unfulfilled");
  assert.equal(imsPayloadProblem(p), null);
});

test("IMS payload: payment method, events, problems that make an order unsendable", () => {
  assert.equal(paymentMethod(node({ paymentGatewayNames: ["Cash on Delivery (COD)"], displayFinancialStatus: "PENDING" })), "cod");
  assert.equal(paymentMethod(node({ paymentGatewayNames: ["razorpay"], displayFinancialStatus: "PENDING" })), "pending");
  assert.equal(imsEventFor("orders/create"), "order.created");
  assert.equal(imsEventFor("ORDERS_CREATE"), "order.created");
  assert.equal(imsEventFor("orders/updated"), "order.updated");
  assert.equal(imsEventFor("fulfillments/create"), "order.updated");
  assert.equal(imsEventFor("orders/cancelled"), "order.cancelled");
  assert.equal(imsEventFor("orders/updated", { cancelledAt: "2026-11-25T00:00:00Z" }), "order.cancelled", "a cancelled order is always a cancel");

  const noSku = buildImsPayload(node({ lineItems: { nodes: [{ title: "Custom item", quantity: 1, sku: null, discountedUnitPriceSet: { shopMoney: { amount: "10" } }, taxLines: [] }] } }), "order.created", "s.myshopify.com");
  assert.match(String(imsPayloadProblem(noSku)), /SKU.*Custom item/);
  assert.match(String(imsPayloadProblem({ ...noSku, shopifyOrderId: "" } as any)), /no Shopify id/);
  assert.equal(imsUrlProblem(URL_OK), null);
  assert.match(String(imsUrlProblem("http://ims.example.com/api/x")), /https/);
  assert.match(String(imsUrlProblem("not a url")), /web address/);
  assert.match(String(imsUrlProblem("https://ims.example.com")), /path/);
  assert.deepEqual([1, 2, 3, 10].map(retryDelayMs), [30_000, 60_000, 120_000, 3_600_000], "waits grow, at most an hour");
});

test("IMS settings: address checked, key stored encrypted and never given back", async () => {
  const { saveImsConfig, getImsConfig }: any = await loadApp("/app/lib/ims-push.server.ts");
  assert.equal((await saveImsConfig(SHOP, { url: "http://ims.example.com/x", key: "abcdefgh1234", enabled: true })).ok, false, "http is refused");
  assert.equal((await saveImsConfig(SHOP, { url: URL_OK, key: "", enabled: true })).ok, false, "switching on needs a key");
  assert.equal((await saveImsConfig(SHOP, { url: URL_OK, key: "short", enabled: true })).ok, false);
  assert.equal((await saveImsConfig(SHOP, { url: URL_OK, key: "ims-secret-key-9876", enabled: true })).ok, true);
  const raw = await prisma.imsConfig.findUnique({ where: { shop: SHOP } });
  assert.ok(raw && raw.keyEnc && !raw.keyEnc.includes("ims-secret-key"), "the key is encrypted in the database");
  const cfg = await getImsConfig(SHOP);
  assert.deepEqual([cfg.enabled, cfg.url, cfg.hasKey, cfg.keyHint], [true, URL_OK, true, "9876"]);
  assert.ok(!JSON.stringify(cfg).includes("ims-secret-key"), "the key is never returned");
  // saving again without a key keeps the old one
  assert.equal((await saveImsConfig(SHOP, { url: URL_OK, key: "", enabled: true })).ok, true);
  assert.equal((await getImsConfig(SHOP)).keyHint, "9876");
});

const fakeIms = (answers: number[] | ((n: number) => number | Error)) => {
  const calls: { url: string; key: string | null; body: any }[] = [];
  const fetchFn = async (url: any, init: any) => {
    calls.push({ url: String(url), key: init.headers["x-api-key"], body: JSON.parse(init.body) });
    const a = typeof answers === "function" ? answers(calls.length) : answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return new Response(a === 401 ? "bad key" : "{}", { status: a });
  };
  return { calls, fetchFn: fetchFn as any };
};
const gqlWith = (n: any) => (async () => ({ order: n })) as any;
const rowOf = (gid: string) => prisma.imsPush.findUniqueOrThrow({ where: { shop_orderGid: { shop: SHOP, orderGid: gid } } });

test("IMS outbox: queued only when switched on; newer changes merge; sent, retried, failed", async () => {
  const s: any = await loadApp("/app/lib/ims-push.server.ts");
  const gid = "gid://shopify/Order/5123456789";
  await prisma.imsPush.deleteMany({ where: { shop: SHOP } });

  await prisma.imsConfig.update({ where: { shop: SHOP }, data: { enabled: false } });
  assert.equal(await s.enqueueImsPush(SHOP, gid, "order.created"), false, "switched off: nothing is queued");
  await prisma.imsConfig.update({ where: { shop: SHOP }, data: { enabled: true } });

  assert.equal(await s.enqueueImsPush(SHOP, gid, "order.created", { orderName: "#1234" }), true);
  await s.enqueueImsPush(SHOP, gid, "order.updated");
  let r = await rowOf(gid);
  assert.deepEqual([r.event, r.status], ["order.created", "pending"], "an update of an order that was not sent yet stays 'created'");
  await s.enqueueImsPush(SHOP, gid, "order.cancelled");
  assert.equal((await rowOf(gid)).event, "order.cancelled", "a cancel always wins");
  await s.enqueueImsPush(SHOP, gid, "order.created", { delayMs: 0 });

  // sent: the IMS gets the key and the spec'd body once
  const ok = fakeIms([200]);
  assert.deepEqual(await s.processImsQueue({ fetchFn: ok.fetchFn, run: gqlWith(node()) }), { sent: 1, retry: 0, failed: 0 });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, URL_OK);
  assert.equal(ok.calls[0].key, "ims-secret-key-9876");
  assert.equal(ok.calls[0].body.shopDomain, SHOP);
  assert.equal(ok.calls[0].body.items[0].sku, "HP-1008W");
  r = await rowOf(gid);
  assert.deepEqual([r.status, r.orderName], ["sent", "#1234"]);
  assert.equal((await s.processImsQueue({ fetchFn: ok.fetchFn, run: gqlWith(node()) })).sent, 0, "a sent order is not sent again");

  // a change after it was sent goes out again (the IMS updates the same shopifyOrderId)
  await s.enqueueImsPush(SHOP, gid, "order.updated", { delayMs: 0 });
  assert.equal((await rowOf(gid)).status, "pending");
  const again = fakeIms([201]);
  assert.equal((await s.processImsQueue({ fetchFn: again.fetchFn, run: gqlWith(node({ displayFulfillmentStatus: "FULFILLED" })) })).sent, 1, "201 counts as received too");
  assert.equal(again.calls[0].body.event, "order.updated");
  assert.equal(again.calls[0].body.fulfillmentStatus, "fulfilled");

  // a server error: retry later with growing waits; the reason is kept
  await s.enqueueImsPush(SHOP, gid, "order.updated", { delayMs: 0 });
  const bad = fakeIms([500]);
  assert.deepEqual(await s.processImsQueue({ fetchFn: bad.fetchFn, run: gqlWith(node()) }), { sent: 0, retry: 1, failed: 0 });
  r = await rowOf(gid);
  assert.deepEqual([r.status, r.attempts], ["pending", 1]);
  assert.match(String(r.lastError), /HTTP 500/);
  assert.ok(r.nextAttemptAt.getTime() > Date.now() + 20_000, "not tried again at once");
  assert.equal((await s.processImsQueue({ fetchFn: bad.fetchFn, run: gqlWith(node()) })).retry, 0, "not due yet: left alone");
  assert.match(String((await prisma.imsConfig.findUnique({ where: { shop: SHOP } }))?.lastError), /HTTP 500/, "the page can show the last problem");

  // wrong key: a clear hint; the network down: a clear message
  await prisma.imsPush.update({ where: { id: r.id }, data: { nextAttemptAt: new Date() } });
  await s.processImsQueue({ fetchFn: fakeIms([401]).fetchFn, run: gqlWith(node()) });
  assert.match(String((await rowOf(gid)).lastError), /API key was not accepted/);
  await prisma.imsPush.update({ where: { id: r.id }, data: { nextAttemptAt: new Date() } });
  await s.processImsQueue({ fetchFn: fakeIms(() => new Error("ECONNREFUSED")).fetchFn, run: gqlWith(node()) });
  assert.match(String((await rowOf(gid)).lastError), /Could not reach the IMS: ECONNREFUSED/);

  // too many tries: failed, and "Retry failed" puts it back
  await prisma.imsPush.update({ where: { id: r.id }, data: { nextAttemptAt: new Date(), attempts: MAX_ATTEMPTS - 1 } });
  assert.deepEqual(await s.processImsQueue({ fetchFn: fakeIms([500]).fetchFn, run: gqlWith(node()) }), { sent: 0, retry: 0, failed: 1 });
  assert.equal((await rowOf(gid)).status, "failed");
  assert.equal(await s.retryFailedImsPushes(SHOP), 1);
  assert.deepEqual([(await rowOf(gid)).status, (await rowOf(gid)).attempts], ["pending", 0]);
});

test("IMS outbox: an order that can never be sent fails at once with the reason, without calling the IMS", async () => {
  const s: any = await loadApp("/app/lib/ims-push.server.ts");
  const gid = "gid://shopify/Order/9001";
  await prisma.imsPush.deleteMany({ where: { shop: SHOP } });
  await s.enqueueImsPush(SHOP, gid, "order.created");
  const ims = fakeIms([200]);
  const noSku = node({ legacyResourceId: "9001", name: "#9001", lineItems: { nodes: [{ title: "Custom print", quantity: 1, sku: null, discountedUnitPriceSet: { shopMoney: { amount: "10" } }, taxLines: [] }] } });
  assert.deepEqual(await s.processImsQueue({ fetchFn: ims.fetchFn, run: gqlWith(noSku) }), { sent: 0, retry: 0, failed: 1 });
  assert.equal(ims.calls.length, 0, "the IMS is not called with an order it would refuse");
  const r = await rowOf(gid);
  assert.equal(r.status, "failed");
  assert.match(String(r.lastError), /SKU.*Custom print/);
  const st = await s.imsStatus(SHOP);
  assert.deepEqual([st.failed, st.failedList[0].name], [1, "#9001"], "the page lists it with the reason");

  // an order deleted in Shopify
  await s.enqueueImsPush(SHOP, "gid://shopify/Order/9002", "order.created");
  await s.processImsQueue({ fetchFn: ims.fetchFn, run: gqlWith(null) });
  assert.match(String((await rowOf("gid://shopify/Order/9002")).lastError), /no longer exists/);

  // Shopify itself failing is a "try again later", never a failure
  await s.enqueueImsPush(SHOP, "gid://shopify/Order/9003", "order.created");
  const out = await s.processImsQueue({ fetchFn: ims.fetchFn, run: (async () => { throw new Error("throttled"); }) as any });
  assert.equal(out.retry, 1);
});

test("IMS outbox: old orders go in batches of 10; one order can be sent by number", async () => {
  const s: any = await loadApp("/app/lib/ims-push.server.ts");
  await prisma.imsPush.deleteMany({ where: { shop: SHOP } });
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  for (let i = 1; i <= 25; i++) await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: String(7000 + i), orderName: `#W${7000 + i}`, orderDate: new Date(2026, 10, i), status: "Delivered" } });
  await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: "manual-1", isManual: true, orderName: "hand" } });

  assert.equal(await s.enqueueAllOrders(SHOP), 25, "hand-added rows are not Shopify orders and are not sent");
  assert.equal((await s.enqueueAllOrders(SHOP)), 25, "pressing it twice does not duplicate anything");
  assert.equal(await prisma.imsPush.count({ where: { shop: SHOP } }), 25);

  const ims = fakeIms([200]);
  const run = (async (_s: string, _q: string, v: any) => ({ order: node({ legacyResourceId: v.id.split("/").pop(), name: `#W${v.id.split("/").pop()}` }) })) as any;
  assert.equal((await s.processImsQueue({ fetchFn: ims.fetchFn, run })).sent, 10, "10 per round");
  assert.equal((await s.processImsQueue({ fetchFn: ims.fetchFn, run })).sent, 10);
  assert.equal((await s.processImsQueue({ fetchFn: ims.fetchFn, run })).sent, 5);
  assert.deepEqual([(await s.imsStatus(SHOP)).sent, (await s.imsStatus(SHOP)).pending], [25, 0]);
  assert.equal(new Set(ims.calls.map((c) => c.body.shopifyOrderId)).size, 25, "every order went once");

  const one = await s.enqueueOneOrder(SHOP, "w7003");
  assert.deepEqual(one, { ok: true, name: "#W7003" });
  assert.equal((await rowOf("gid://shopify/Order/7003")).status, "pending");
  assert.equal((await s.enqueueOneOrder(SHOP, "#W9999")).ok, false);
  assert.equal((await s.enqueueOneOrder(SHOP, "hello")).ok, false);
});
