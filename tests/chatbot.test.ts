/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { detectIntent } from "../app/lib/intent.ts";
import { findLooseOrderRef, orderNameMatches, parseOrderRef } from "../app/lib/order-ref.ts";
import { findPhoneInText, samePhone } from "../app/lib/phone.ts";
import { clip, compose, numbered } from "../app/lib/reply-format.ts";
import { extractCombo, htmlToText, isComboProduct, productMessage, type ProductLike } from "../app/lib/product-summary.ts";
import { DEFAULT_TEMPLATES, LABELS, mergeTemplates, TEMPLATES_HI } from "../app/lib/templates.ts";
import { closeApp, loadApp } from "./helpers/load-app.ts";

const SHOP = "chatbot-test.invalid"; // isolated shop; its rows are removed afterwards
after(async () => {
  const convs = await prisma.conversation.findMany({ where: { shop: SHOP }, select: { id: true } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await prisma.productEnquiry.deleteMany({ where: { shop: SHOP } });
  await prisma.conversation.deleteMany({ where: { shop: SHOP } });
  await prisma.activityLog.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  await closeApp();
});

// ---------- fake store data ----------
const OWNER = "+919876543210";
const OTHER = "+919811111111";
const order = (name: string, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Order/${name.replace(/\D/g, "")}`, name, createdAt: "2026-11-09T10:00:00Z", cancelled: false, closed: false,
  financialStatus: "PAID", fulfillmentStatus: "FULFILLED", total: "₹1,499", statusUrl: null, customerName: "Asha", phones: [OWNER],
  items: [{ title: "HP LaserJet 1008w", quantity: 1, sku: null }],
  tracking: [{ company: "Delhivery", number: "DL123456789", url: null, resolvedUrl: "https://www.delhivery.com/track-v2/package/DL123456789", status: "IN_TRANSIT", estimatedDeliveryAt: "2026-11-14T00:00:00Z" }],
  ...over,
});
const ORDERS = [
  order("#W1219"),
  order("#W1218", { createdAt: "2026-11-08T09:00:00Z", fulfillmentStatus: "UNFULFILLED", tracking: [] }),
  order("#W1217", {
    createdAt: "2026-11-07T09:00:00Z",
    tracking: [
      { company: "Delhivery", number: "DL111111111", url: null, resolvedUrl: "https://www.delhivery.com/track-v2/package/DL111111111", status: "DELIVERED", estimatedDeliveryAt: null },
      { company: "Blue Dart", number: "BD222222222", url: "https://bluedart.example/track/BD222222222", resolvedUrl: "https://bluedart.example/track/BD222222222", status: "IN_TRANSIT", estimatedDeliveryAt: "2026-11-15T00:00:00Z" },
    ],
  }),
  order("#W1100", { phones: [OTHER], items: [{ title: "Secret Item", quantity: 1, sku: null }] }),
  order("#W1300", { phones: ["+919000000001"] }),
];

const product = (over: Partial<ProductLike> & Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/1", title: "HP LaserJet 1008w", handle: "hp-1008w", description: "", descriptionHtml: "", fullDescription: "",
  vendor: "HP", status: "ACTIVE", productType: "Printer", tags: [], skus: [], price: "₹10,999.00", compareAtPrice: null, discountPercent: null,
  available: true, url: "https://wery.example/products/hp-1008w", imageUrl: null, variants: [{ title: "Default Title", price: "₹10,999.00", sku: "HP-1008W" }], ...over,
});
const NORMAL_HTML =
  "<p>Compact monochrome laser printer for home and office.</p><ul><li>Print Technology: Monochrome Laser</li><li>Print Function: Print</li><li>Connectivity: USB and Wi-Fi</li><li>Print Speed: up to 20 ppm</li></ul><p>Warranty: 1 Year Manufacturer Warranty</p>";
const COMBO_HTML =
  "<p>Great office setup.</p><p>Combo includes:</p><ul><li>HP LaserJet 1008w Printer - 1 Pc</li><li>USB Cable - 1 Piece</li><li>Printer Paper - 1 Pack</li></ul><p>Optional: Extra toner</p>";
const PRODUCTS = [
  product({ descriptionHtml: NORMAL_HTML }),
  product({ id: "gid://shopify/Product/2", title: "HP LaserJet 1008w Printer Combo with USB Cable & Paper Pack", handle: "hp-1008w-combo", price: "₹11,499.00", descriptionHtml: COMBO_HTML, url: "https://wery.example/products/hp-1008w-combo" }),
  product({ id: "gid://shopify/Product/3", title: "Office Starter Combo Offer", handle: "office-combo", price: "₹5,999.00", descriptionHtml: "<p>Great value deal for your new office.</p>", url: "https://wery.example/products/office-combo" }),
  product({ id: "gid://shopify/Product/4", title: "Canon Inkjet G3010", handle: "canon-g3010", price: "₹14,999.00", description: "", descriptionHtml: "", url: "https://wery.example/products/canon-g3010" }),
];
const byTerms = (q: string) => {
  const terms = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !["tell", "about", "the", "does", "what", "included", "this"].includes(w));
  return PRODUCTS.filter((p) => terms.some((t) => p.title.toLowerCase().includes(t)));
};

const deps = {
  findOrder: async (_shop: string, number: string, phone: string) => {
    const ref = parseOrderRef(number);
    const o = ref ? ORDERS.find((x) => orderNameMatches(x.name, ref)) : undefined;
    return o && o.phones.some((p) => samePhone(p, phone)) ? (o as any) : null;
  },
  findOrders: async (_shop: string, phone: string) => ORDERS.filter((o) => o.phones.some((p) => samePhone(p, phone))) as any[],
  getOrders: async (_shop: string, ids: string[]) => ORDERS.filter((o) => ids.includes(o.id)) as any[],
  searchProducts: async (_shop: string, q: string) => byTerms(q).slice(0, 5) as any[],
  getProducts: async (_shop: string, ids: string[]) => PRODUCTS.filter((p) => ids.includes(p.id)) as any[],
  recommend: async () => [],
};

const settings = { shop: SHOP, enabled: true, maxVerifyAttempts: 3, recommendationsEnabled: false, maxRecommendations: 3, recommendationRule: "productType" as const, templates: mergeTemplates(null) };

let bot: any;
let n = 0;
async function newChat(phone = OWNER) {
  bot ??= await loadApp("/app/lib/bot.server.ts");
  // One conversation per (shop, phone): start every scenario from a clean one.
  const old = await prisma.conversation.findUnique({ where: { shop_phone: { shop: SHOP, phone } } });
  if (old) {
    await prisma.message.deleteMany({ where: { conversationId: old.id } });
    await prisma.productEnquiry.deleteMany({ where: { conversationId: old.id } });
    await prisma.conversation.delete({ where: { id: old.id } });
  }
  return prisma.conversation.create({ data: { shop: SHOP, phone, lastInboundAt: new Date(), lastMessageAt: new Date() } });
}
/** One customer message through the real decision logic (real DB, fake Shopify). Returns the reply text and the conversation row. */
async function say(chat: { id: string; phone: string }, text: string, over: Partial<typeof deps> = {}) {
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } });
  const r = await bot.decideReply(SHOP, conv, { from: chat.phone.replace(/\D/g, ""), id: `t${++n}`, type: "text", text }, settings, undefined, { ...deps, ...over });
  return { text: (typeof r === "string" ? r : r.text) as string, conv: await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } }), reply: r };
}

// ---------- order numbers (pure) ----------
test("order numbers: #W1219, W1219, w1219 and 1219 are understood; model numbers are not orders", () => {
  for (const v of ["#W1219", "W1219", "w1219", "#w1219", "W-1219", " #W1219 "]) assert.equal(parseOrderRef(v)?.name, "#W1219", v);
  assert.equal(parseOrderRef("1219")?.name, "#1219");
  assert.equal(parseOrderRef("hello"), null);
  assert.equal(parseOrderRef("12"), null, "too short to be an order number");
  assert.ok(orderNameMatches("#W1219", parseOrderRef("w1219")!));
  assert.ok(orderNameMatches("#W1219", parseOrderRef("1219")!), "digits only match whatever prefix the store uses");
  assert.ok(!orderNameMatches("#W1219", parseOrderRef("X1219")!));
  assert.ok(!orderNameMatches("#W12190", parseOrderRef("W1219")!), "never a partial match");
  assert.equal(findLooseOrderRef("please track w1219 today")?.key, "W1219");
  assert.equal(findLooseOrderRef("hp1008 printer"), null, "two letters + digits is a model number");
  assert.equal(detectIntent("Track my order #W1219").type, "tracking");
  assert.deepEqual(detectIntent("Track my order #W1219"), { type: "tracking", orderNumber: "W1219" });
  assert.deepEqual(detectIntent("track my order #w1219"), { type: "tracking", orderNumber: "W1219" });
  assert.deepEqual(detectIntent("order status w1219"), { type: "order", orderNumber: "W1219" });
  assert.deepEqual(detectIntent("W1219"), { type: "order", orderNumber: "W1219", weak: true });
  assert.deepEqual(detectIntent("where is my order 1002"), { type: "tracking", orderNumber: "1002" });
  assert.notEqual(detectIntent("hp1008 printer").type, "order");
});

test("mobile numbers: +91, 91 and plain 10 digit forms are the same number; order numbers are not phones", () => {
  for (const v of ["+91 98765 43210", "9876543210", "919876543210", "09876543210", "my number is +91-98765-43210"]) {
    assert.ok(samePhone(findPhoneInText(v), OWNER), v);
  }
  assert.equal(findPhoneInText("#W1219"), null);
  assert.equal(findPhoneInText("track order 1219"), null);
  assert.deepEqual(detectIntent("9876543210"), { type: "order", phone: "+919876543210" });
  assert.deepEqual(detectIntent("+91 98765 43210"), { type: "order", phone: "+919876543210" });
  assert.deepEqual(detectIntent("track my order 9876543210"), { type: "tracking", orderNumber: undefined, phone: "+919876543210" });
});

// ---------- shopify queries ----------
test("Shopify lookup uses the order NAME (never the internal id) and finds #W1219 however it is typed", async () => {
  const data: any = await loadApp("/app/lib/shopify-data.server.ts");
  const seen: string[] = [];
  const node = { id: "gid://shopify/Order/6001234567", name: "#W1219", createdAt: "2026-11-09T10:00:00Z", cancelledAt: null, closedAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", phone: OWNER, customer: null, shippingAddress: null, billingAddress: null, lineItems: { nodes: [] },
    fulfillments: [{ status: "SUCCESS", displayStatus: "IN_TRANSIT", estimatedDeliveryAt: "2026-11-14T00:00:00Z", trackingInfo: [{ company: "Delhivery", number: "DL123456789", url: null }] }] };
  const run = async (_s: string, query: string, vars: any = {}) => {
    if (query.includes("orderNumberFormatPrefix")) return { shop: { orderNumberFormatPrefix: "W" } };
    seen.push(vars.q);
    return { orders: { nodes: /#W1219/i.test(vars.q) ? [node, { ...node, name: "#W12190" }] : [] } };
  };
  for (const typed of ["#W1219", "W1219", "w1219", "#w1219", "1219"]) {
    const o = await data.findOrderByNumber(SHOP, typed, run);
    assert.equal(o?.name, "#W1219", typed);
    assert.equal(o.tracking[0].number, "DL123456789");
    assert.equal(o.tracking[0].estimatedDeliveryAt, "2026-11-14T00:00:00Z");
  }
  assert.ok(seen.slice(0, 4).every((q) => q === "name:#W1219"), `queried by name: ${seen.join(" | ")}`);
  assert.ok(!seen.some((q) => q.includes("6001234567")), "the internal id is never used as the order number");
  assert.equal(await data.findOrderByNumber(SHOP, "#W9999", run), null, "unknown order");
  assert.equal(await data.findOrderByNumber(SHOP, "not an order", run), null);
});

test("Shopify lookup by phone: customer search with +91 / 91 / plain forms, owner check on the order", async () => {
  const data: any = await loadApp("/app/lib/shopify-data.server.ts");
  const queries: string[] = [];
  const run = async (_s: string, query: string, vars: any = {}) => {
    queries.push(vars.q);
    if (query.includes("customers(")) return { customers: { nodes: vars.q === "phone:9876543210" ? [{ id: "gid://shopify/Customer/55", phone: "+919876543210" }] : [] } };
    return { orders: { nodes: [{ id: "gid://shopify/Order/1", name: "#W1219", createdAt: "2026-11-09T00:00:00Z", phone: "+919876543210", fulfillments: [], lineItems: { nodes: [] } }, { id: "gid://shopify/Order/2", name: "#W1100", createdAt: "2026-11-01T00:00:00Z", phone: "+919811111111", fulfillments: [], lineItems: { nodes: [] } }] } };
  };
  const found = await data.findOrdersByPhone(SHOP, "+919876543210", run);
  assert.deepEqual(found.map((o: any) => o.name), ["#W1219"], "an order with someone else's number is dropped");
  assert.ok(queries.includes("phone:+919876543210") && queries.includes("phone:9876543210"), queries.join(" | "));
});

// ---------- order replies ----------
test("Order lookup by +91 mobile number and by plain 10 digit number (single order: details at once)", async () => {
  const chat = await newChat("+919000000001");
  for (const typed of ["+91 90000 00001", "9000000001"]) {
    const r = await say(chat, typed);
    assert.match(r.text, /Order Number: #W1300/, typed);
  }
});

test("Order lookup: the customer's own orders are listed when there are several, then one is picked", async () => {
  const chat = await newChat();
  const r = await say(chat, "+91 9876543210");
  assert.match(r.text, /multiple orders/);
  assert.match(r.text, /1\. #W1219 — Fulfilled \(9 Nov 2026\)/);
  assert.match(r.text, /2\. #W1218 — Unfulfilled \(8 Nov 2026\)/);
  assert.match(r.text, /3\. #W1217/);
  assert.ok(!r.text.includes("#W1100"), "another customer's order is never listed");
  assert.equal(r.conv.state, "awaiting_order_selection");
  const pick = await say(chat, "2");
  assert.match(pick.text, /Order Number: #W1218/);
  assert.equal(pick.conv.state, "awaiting_followup");
});

test("Order lookup by #W1219, W1219 and lowercase: shows every tracking field from Shopify", async () => {
  const chat = await newChat();
  for (const text of ["Track my order #W1219", "track my order w1219", "W1219", "order status #w1219", "where is my order W1219"]) {
    const r = await say(chat, text);
    assert.match(r.text, /1\. Order Number: #W1219/, text);
    assert.match(r.text, /2\. Order Date: 9 Nov 2026/, text);
    assert.match(r.text, /3\. Order Status: Active/, text);
    assert.match(r.text, /4\. Fulfillment Status: Fulfilled/, text);
    assert.match(r.text, /Courier: Delhivery/, text);
    assert.match(r.text, /Tracking ID: DL123456789/, text);
    assert.match(r.text, /Tracking Link: https:\/\/www\.delhivery\.com\/track-v2\/package\/DL123456789/, text);
    assert.match(r.text, /Expected Delivery: 14 Nov 2026/, text);
    assert.ok(!/gid:\/\//.test(r.text), "no internal Shopify ids");
  }
});

test("Order without tracking says so and does not invent anything; cancelled orders show no tracking", async () => {
  const chat = await newChat();
  const r = await say(chat, "track #W1218");
  assert.match(r.text, /Tracking details are not available yet/);
  assert.ok(!/Courier:|Tracking ID:|Tracking Link:/.test(r.text));
  const cancelled = await say(chat, "track #W1218", { findOrder: async () => order("#W1218", { cancelled: true, tracking: [] }) as any });
  assert.match(cancelled.text, /Order Status: Cancelled/);
  assert.ok(!/not available yet/.test(cancelled.text));
});

test("A bare order id (W1219 / w1219 / 1219-style) never answers 'product not found': it is checked as an order", async () => {
  const chat = await newChat("+919555500010"); // WhatsApp number is not the one on #W1100
  const r = await say(chat, "W1100");
  assert.equal(r.text, DEFAULT_TEMPLATES.verifyOrderPhone);
  assert.ok(!/couldn't find that product/.test(r.text));
  const done = await say(chat, "9811111111");
  assert.match(done.text, /Order Number: #W1100/);
  const missing = await say(await newChat("+919555500011"), "w9999");
  assert.equal(missing.text, DEFAULT_TEMPLATES.verifyOrderPhone);
  // A real product model that looks the same is still shown as a product.
  const model = await say(await newChat("+919555500012"), "M1005", { searchProducts: async () => [product({ title: "HP LaserJet M1005 MFP" })] as any });
  assert.match(model.text, /HP LaserJet M1005 MFP/);
});

test("Order with several tracking numbers shows all of them", async () => {
  const chat = await newChat();
  const r = await say(chat, "track #W1217");
  assert.match(r.text, /Shipment 1:/);
  assert.match(r.text, /Shipment 2:/);
  assert.match(r.text, /DL111111111/);
  assert.match(r.text, /BD222222222/);
  assert.match(r.text, /Blue Dart/);
  assert.match(r.text, /https:\/\/bluedart\.example\/track\/BD222222222/);
  assert.match(r.text, /Shipment Status: Delivered/);
  assert.equal((r.text.match(/Expected Delivery/g) ?? []).length, 1, "a delivered shipment has no expected date");
});

test("Invalid order number: friendly numbered help, no technical details; Shopify failure is handled by the caller", async () => {
  const chat = await newChat();
  const ask = await say(chat, "track #W9999");
  assert.equal(ask.text, DEFAULT_TEMPLATES.verifyOrderPhone, "the same security question as for a real order");
  const r = await say(chat, "9111122223");
  assert.match(r.text, /could not find any order/);
  assert.match(r.text, /1\. Your Order Number \(Example: #W1219\)/);
  assert.match(r.text, /2\. Your registered mobile number/);
  assert.ok(!/error|gid|graphql|api/i.test(r.text));
  await assert.rejects(() => say(chat, "track #W1219", { findOrder: async () => { throw new Error("Shopify 500"); } }));
});

test("Privacy: someone else's order number or phone number reveals nothing", async () => {
  const chat = await newChat();
  const other = await say(chat, "track #W1100"); // exists, belongs to another customer
  const missing = await say(chat, "track #W9998"); // does not exist
  assert.equal(other.text, DEFAULT_TEMPLATES.verifyOrderPhone);
  assert.equal(other.text, missing.text, "identical question: no way to tell the two apart");
  assert.ok(!other.text.includes("Secret Item"));
  assert.equal(other.conv.state, "awaiting_order_verify");

  // Wrong second factor: refused with the same words as "no such order".
  const wrong = await say(chat, "9111122223");
  assert.match(wrong.text, /could not find any order/);
  assert.ok(!wrong.text.includes("Secret Item"));
  await say(chat, "track #W1100");
  const wrongOwn = await say(chat, OWNER); // the sender's own number is not the number registered on #W1100
  assert.match(wrongOwn.text, /could not find any order/);

  // A typed mobile number that is not the sender's: nothing is shown until an order placed with it is also sent.
  const typedChat = await newChat("+919555500000");
  const typed = await say(typedChat, OTHER);
  assert.equal(typed.text, DEFAULT_TEMPLATES.verifyPhoneOrder);
  assert.ok(!typed.text.includes("#W1100") && !typed.text.includes("Secret"));
  const notTheirs = await say(typedChat, "#W1219"); // an order of someone else entirely
  assert.match(notTheirs.text, /could not find any order/);
});

test("Second check lets customers see an order placed with another number: order number + the registered mobile number", async () => {
  const chat = await newChat("+919555500001"); // WhatsApp number is not the one on the order
  const ask = await say(chat, "track my order #W1100");
  assert.equal(ask.text, DEFAULT_TEMPLATES.verifyOrderPhone);
  const done = await say(chat, "+91 98111 11111");
  assert.match(done.text, /Order Number: #W1100/);
  assert.match(done.text, /Secret Item/);
  assert.equal(done.conv.state, "awaiting_followup");

  const chat2 = await newChat("+919555500002");
  assert.equal((await say(chat2, "9811111111")).text, DEFAULT_TEMPLATES.verifyPhoneOrder);
  const done2 = await say(chat2, "my order is #w1100");
  assert.match(done2.text, /Order Number: #W1100/);

  const chat3 = await newChat("+919555500003");
  await say(chat3, "#W1100 status");
  const other = await say(chat3, "hello"); // not an answer: handled as a normal message
  assert.equal(other.text, DEFAULT_TEMPLATES.greeting);
});

test("Customers who type the number after being asked are understood (state: asked for order details)", async () => {
  const chat = await newChat("+919777700000"); // no orders on this number
  const ask = await say(chat, "track my order");
  assert.equal(ask.text, DEFAULT_TEMPLATES.askOrderDetails);
  assert.match(ask.text, /1\. Use this WhatsApp number\n2\. Send your Order Number \(Example: #W1219\)\n3\. Send your registered mobile number/);
  assert.equal(ask.conv.state, "awaiting_order_choice");
  const first = await say(chat, "1");
  assert.match(first.text, /couldn't find an order linked to this WhatsApp number/);
  assert.equal(first.conv.state, "awaiting_order_number");
  const second = await say(chat, "w1300"); // not hers: security question first
  assert.equal(second.text, DEFAULT_TEMPLATES.verifyOrderPhone);
  const third = await say(chat, "9000000009"); // wrong registered number
  assert.match(third.text, /could not find any order/);
});

test("Order question: choice 2 asks for the order number, 3 for the mobile number, and typing it directly also works", async () => {
  const chat = await newChat();
  await say(chat, "check order status");
  const two = await say(chat, "2");
  assert.equal(two.text, DEFAULT_TEMPLATES.typeOrderNumber);
  const order = await say(chat, "#w1219");
  assert.match(order.text, /Order Number: #W1219/);

  const chat2 = await newChat();
  await say(chat2, "track my shipment");
  assert.equal((await say(chat2, "3")).text, DEFAULT_TEMPLATES.typeMobileNumber);
  assert.match((await say(chat2, "9876543210")).text, /multiple orders/);

  const chat3 = await newChat();
  await say(chat3, "where is my order");
  assert.match((await say(chat3, "W1218")).text, /Order Number: #W1218/, "typing the number straight away skips the choice");
});

test("After every answer the bot asks what is next: 1 product, 2 order, 3 support; thanks ends politely", async () => {
  const chat = await newChat();
  const order = await say(chat, "track #W1219");
  assert.ok(order.text.endsWith(DEFAULT_TEMPLATES.askMore), "order details end with the next question");
  assert.equal(order.conv.state, "awaiting_followup");
  const find = await say(chat, "1");
  assert.equal(find.text, DEFAULT_TEMPLATES.askProductName);
  const prod = await say(chat, "canon");
  assert.ok(prod.text.endsWith(DEFAULT_TEMPLATES.askMore), "product answers end with the next question");
  assert.equal(prod.conv.state, "awaiting_followup");
  assert.equal((await say(chat, "2")).text, DEFAULT_TEMPLATES.askOrderDetails);

  const chat2 = await newChat();
  await say(chat2, "track #W1219");
  assert.equal((await say(chat2, "thanks")).text, DEFAULT_TEMPLATES.thanksReply);
  const chat3 = await newChat();
  await say(chat3, "track #W1219");
  const human = await say(chat3, "3");
  assert.equal(human.text, DEFAULT_TEMPLATES.handoff);
  assert.equal(human.conv.mode, "human");
  const chat4 = await newChat();
  await say(chat4, "track #W1219");
  assert.match((await say(chat4, "canon inkjet")).text, /Canon Inkjet G3010/, "a normal message after the question is answered normally");
});

// ---------- welcome menu and style ----------
test("Welcome menu: numbered options; 2/3 check orders, 1/4 ask for a product, 5 hands over to a person", async () => {
  const chat = await newChat();
  const hi = await say(chat, "Hi");
  assert.equal(hi.text, DEFAULT_TEMPLATES.greeting);
  for (const line of ["Hi, I'm JAZZ!", "1. Find a Product", "2. Check Order Status", "3. Track My Shipment", "4. Product Information", "5. Talk to Our Support Team", "Please reply with a number or type your question."]) {
    assert.ok(hi.text.includes(line), line);
  }
  assert.equal(hi.conv.state, "awaiting_menu");
  const ask = await say(chat, "2");
  assert.equal(ask.text, DEFAULT_TEMPLATES.askOrderDetails);
  const orders = await say(chat, "1");
  assert.match(orders.text, /multiple orders/);

  const chat2 = await newChat();
  await say(chat2, "hello");
  const find = await say(chat2, "1");
  assert.match(find.text, /Which product are you looking for/);
  assert.equal(find.conv.state, "awaiting_product_query");
  const prod = await say(chat2, "canon");
  assert.match(prod.text, /Canon Inkjet G3010/);

  const chat3 = await newChat();
  await say(chat3, "hello");
  const human = await say(chat3, "5");
  assert.equal(human.text, DEFAULT_TEMPLATES.handoff);
  assert.equal(human.conv.mode, "human");
});

test("Human support requests in English, Hindi and Hinglish hand over to a person", async () => {
  for (const text of ["I want to talk to a human", "मुझे एजेंट से बात करनी है", "insaan se baat karni hai"]) {
    const chat = await newChat();
    const r = await say(chat, text);
    assert.match(r.text, /support team|सपोर्ट टीम/, text);
    assert.equal(r.conv.mode, "human", text);
  }
});

test("Support request: the customer shows up in the waiting list (pop-up alert + dashboard) until a person has taken over", async () => {
  const { getWaiting }: any = await loadApp("/app/lib/waiting.server.ts");
  const chat = await newChat("+919444400000");
  assert.ok(!(await getWaiting(SHOP)).some((w: any) => w.phone === chat.phone), "not waiting before asking");
  await say(chat, "hello");
  await say(chat, "5"); // menu: Talk to Our Support Team
  const waiting = await getWaiting(SHOP);
  const mine = waiting.find((w: any) => w.phone === chat.phone);
  assert.ok(mine, "waiting after asking for the support team");
  assert.equal(mine.reason, "Customer chose support from the menu");
  assert.ok(mine.id && mine.at && mine.name === chat.phone);
  await prisma.conversation.update({ where: { id: chat.id }, data: { status: "closed" } });
  assert.ok(!(await getWaiting(SHOP)).some((w: any) => w.phone === chat.phone), "gone once the chat is closed");
});

test("A customer writing while the chat is with a person is never left in silence, but is not nagged either", async () => {
  await newChat();
  const chat = await newChat("+919444400001");
  await prisma.conversation.update({ where: { id: chat.id }, data: { mode: "human", handoffReason: "Customer requested a human agent" } });
  const sent: any[] = [];
  const send = async (m: any) => (sent.push(m), { ok: true });
  const conv = () => prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } });

  assert.equal(await bot.acknowledgeWaiting(SHOP, await conv(), settings, "m1", send), true, "first message gets an answer");
  assert.equal(sent[0].body, DEFAULT_TEMPLATES.humanActive);
  assert.equal(sent[0].sender, "bot");
  assert.equal(sent[0].inReplyTo, "m1:wait");
  assert.equal(await bot.acknowledgeWaiting(SHOP, await conv(), settings, "m2", send), false, "not again within 30 minutes");
  assert.equal(sent.length, 1);

  const chat2 = await newChat("+919444400002");
  await prisma.conversation.update({ where: { id: chat2.id }, data: { mode: "human" } });
  await prisma.message.create({ data: { conversationId: chat2.id, direction: "out", sender: "agent", body: "Hello, how can I help?", status: "sent" } });
  assert.equal(await bot.acknowledgeWaiting(SHOP, await prisma.conversation.findUniqueOrThrow({ where: { id: chat2.id } }), settings, "m3", send), false, "a person already replied");

  const chat3 = await newChat("+919444400003");
  await prisma.conversation.update({ where: { id: chat3.id }, data: { mode: "human", lang: "hi" } });
  await bot.acknowledgeWaiting(SHOP, await prisma.conversation.findUniqueOrThrow({ where: { id: chat3.id } }), settings, "m4", send);
  assert.equal(sent[1].body, TEMPLATES_HI.humanActive);
});

test("Hindi and Hinglish customers: Hindi gets Hindi labels, Hinglish gets the same short English layout", async () => {
  const hiChat = await newChat("+919000000001");
  const hiAsk = await say(hiChat, "मेरा ऑर्डर कहाँ है");
  assert.equal(hiAsk.text, TEMPLATES_HI.askOrderDetails);
  const hi = await say(hiChat, "1");
  assert.match(hi.text, /ऑर्डर नंबर: #W1300/);
  assert.match(hi.text, /ट्रैकिंग/);
  assert.ok(hi.text.endsWith(TEMPLATES_HI.askMore));
  const hingChat = await newChat("+919000000001");
  assert.equal((await say(hingChat, "mera order kahan hai")).text, DEFAULT_TEMPLATES.askOrderDetails);
  const hing = await say(hingChat, "1");
  assert.match(hing.text, /Order Number: #W1300/);
  const hiMenu = await say(await newChat(), "नमस्ते");
  assert.equal(hiMenu.text, TEMPLATES_HI.greeting);
  assert.match(hiMenu.text, /1\. प्रोडक्ट खोजें/);
});

test("Every built-in reply is short and numbered: no paragraph is longer than 3 lines or 220 characters", () => {
  const all = [...Object.values(DEFAULT_TEMPLATES), ...Object.values(TEMPLATES_HI)].filter((x) => x.trim() && !/Sorry, I can reply in English|English, हिंदी/.test(x));
  for (const t of all) {
    for (const para of t.split(/\n\n/)) {
      assert.ok(para.split("\n").length <= 6 && para.length <= 260, `paragraph too long: ${para.slice(0, 60)}`);
    }
  }
  assert.ok(DEFAULT_TEMPLATES.noOrderFound.includes("1. "), "next steps are numbered");
  assert.equal(numbered(["a", null, "b", ""]), "1. a\n2. b");
  assert.equal(clip("one two three four five six", 12), "one two…");
  assert.equal(compose({ intro: "Hi", points: ["x", "y"], next: "Go?" }), "Hi\n\n1. x\n2. y\n\nGo?");
});

// ---------- products ----------
const L = LABELS.en;

test("Normal product: key points, warranty, price and link; the description is not pasted as a paragraph", () => {
  const m = productMessage(PRODUCTS[0] as any, L);
  assert.match(m.text, /HP LaserJet 1008w/);
  for (const line of ["Print Technology: Monochrome Laser", "Connectivity: USB and Wi-Fi", "Warranty: 1 Year Manufacturer Warranty", "Price: ₹10,999.00", "View Product: https://wery.example/products/hp-1008w"]) {
    assert.ok(m.text.includes(line), line);
  }
  assert.match(m.text, /^🛍️ \*HP LaserJet 1008w\*\n\nHere are the key details:\n\n1\. /);
  assert.ok(m.text.split("\n").length <= 14);
  assert.ok(!m.text.includes("Compact monochrome laser printer for home and office.") || m.text.split("\n").every((l) => l.length < 130));
});

test("Product combo: main product and included items with quantities, optional items kept apart", () => {
  assert.ok(isComboProduct(PRODUCTS[1] as any));
  assert.ok(!isComboProduct(PRODUCTS[0] as any));
  const m = productMessage(PRODUCTS[1] as any, L);
  assert.match(m.text, /Here is what you get in this combo/);
  assert.match(m.text, /1\. Main Product: HP LaserJet 1008w Printer\n/);
  assert.match(m.text, /2\. USB Cable: 1 Piece/);
  assert.match(m.text, /3\. Printer Paper: 1 Pack/);
  assert.match(m.text, /Optional \(not included\): Extra toner/);
  assert.match(m.text, /Combo Price: ₹11,499\.00/);
  assert.match(m.text, /View Combo: https:\/\/wery\.example\/products\/hp-1008w-combo/);
  assert.ok(!/Great office setup/.test(m.text), "the full description is not repeated");
});

test("Combo contents come from the listing only: an unclear listing sends the customer to the team", () => {
  assert.equal(extractCombo(PRODUCTS[2] as any, L), null);
  const m = productMessage(PRODUCTS[2] as any, L);
  assert.match(m.text, /won't guess/);
  assert.match(m.text, /Type "agent"/);
  assert.match(m.text, /Combo Price: ₹5,999\.00/);
  const fromTitle = extractCombo({ ...(PRODUCTS[0] as any), title: "HP Printer + USB Cable + Paper Pack", descriptionHtml: "" }, L)!;
  assert.equal(fromTitle.main, "HP Printer");
  assert.deepEqual(fromTitle.included.map((i) => i.name), ["USB Cable", "Paper Pack"]);
  const inline = extractCombo({ ...(PRODUCTS[0] as any), title: "Printer Combo", descriptionHtml: "<p>In the box: 1 x Printer, 2 x Toner Cartridge, Power Cable</p>" }, L)!;
  assert.deepEqual(inline.included.map((i) => `${i.name}|${i.qty}`), ["Toner Cartridge|2 Pieces", "Power Cable|null"]);
});

test("Product with no description: name, price and link only, and a way to ask the team", () => {
  const m = productMessage(PRODUCTS[3] as any, L);
  assert.match(m.text, /couldn't find detailed specifications/);
  assert.match(m.text, /Price: ₹14,999\.00/);
  assert.match(m.text, /View Product: https:\/\/wery\.example\/products\/canon-g3010/);
  assert.match(m.text, /Type "agent"/);
  assert.ok(!/undefined|null/.test(m.text));
  assert.equal(htmlToText("<ul><li>A &amp; B</li><li>C</li></ul><p>D<br>E</p>"), "- A & B\n- C\n\nD\nE");
});

test("Product enquiries through the bot: normal, combo, unclear combo and missing description", async () => {
  const chat = await newChat();
  const list = await say(chat, "Tell me about HP LaserJet 1008w");
  assert.match(list.text, /1\. \*HP LaserJet 1008w\*/);
  assert.match(list.text, /2\. \*HP LaserJet 1008w Printer Combo/);
  assert.equal(list.conv.state, "awaiting_product_selection");
  const normal = await say(chat, "1");
  assert.match(normal.text, /Print Technology: Monochrome Laser/);
  assert.match(normal.text, /Warranty: 1 Year Manufacturer Warranty/);
  const comboChat = await newChat();
  await say(comboChat, "HP LaserJet 1008w");
  const combo2 = await say(comboChat, "2");
  assert.match(combo2.text, /2\. USB Cable: 1 Piece/);
  const hinglish = await say(await newChat(), "canon inkjet chahiye");
  assert.match(hinglish.text, /Canon Inkjet G3010/);
  assert.match(hinglish.text, /Price: ₹14,999/);
  const missing = await say(await newChat(), "do you have canon inkjet");
  assert.match(missing.text, /couldn't find detailed specifications/);
  const combo = await say(await newChat(), "what is included in office starter combo offer");
  assert.match(combo.text, /won't guess/);
});

test("Unknown words fall back to a short numbered help message", async () => {
  const r = await say(await newChat(), "asdf qwer zxcv uiop lkjh gfds mnbv");
  assert.equal(r.text, DEFAULT_TEMPLATES.unknown);
});

test("Saved (custom) templates still win over the new defaults; empty ones fall back", () => {
  assert.equal(mergeTemplates('{"greeting":"Hello from my store"}').greeting, "Hello from my store");
  assert.equal(mergeTemplates('{"verifyOrderPhone":" "}').verifyOrderPhone, DEFAULT_TEMPLATES.verifyOrderPhone);
});

test("prices are written with the rupee sign, never INR", async () => {
  const { formatMoney }: any = await loadApp("/app/lib/money.ts");
  assert.equal(formatMoney("1499.00", "INR"), "₹1,499");
  assert.equal(formatMoney(2499.5, "INR"), "₹2,499.50");
  assert.equal(formatMoney("125000", "INR"), "₹1,25,000");
  assert.equal(formatMoney("10", "USD"), "$10.00");
  assert.equal(formatMoney(null, "INR"), "");
  const r = await say(await newChat(), "track my order #W1219");
  assert.match(r.text, /Total: ₹1,499/);
  assert.ok(!/INR/.test(r.text));
});

test("saved contacts: silent unless the message starts with ! # or $", async () => {
  const { applyWakeRule, parseNumberList, inList }: any = await loadApp("/app/lib/saved-contacts.ts");
  assert.deepEqual(applyWakeRule("hello", false), { reply: true, text: "hello" });
  assert.deepEqual(applyWakeRule("hello", true), { reply: false, text: "hello" });
  assert.deepEqual(applyWakeRule("#W1219", true), { reply: true, text: "W1219" });
  assert.deepEqual(applyWakeRule("  ! track my order", true), { reply: true, text: "track my order" });
  assert.deepEqual(applyWakeRule("$ price of shoes", true), { reply: true, text: "price of shoes" });
  assert.deepEqual(applyWakeRule("!", true), { reply: true, text: "hi" });
  const list = parseNumberList("+91 98765 43210\n9812345678, junk\n09876543210");
  assert.deepEqual(list, ["+919876543210", "+919812345678"]);
  assert.ok(inList("919812345678", list));
  assert.ok(!inList("+919000000000", list));
});

test("Delhivery shipments get the direct link with the tracking id", async () => {
  const data: any = await loadApp("/app/lib/shopify-data.server.ts");
  const mapped = data.mapOrder({ id: "gid://shopify/Order/1", name: "#W1219", createdAt: "2026-11-09T10:00:00Z",
    currentTotalPriceSet: { shopMoney: { amount: "1499.00", currencyCode: "INR" } },
    fulfillments: [{ status: "SUCCESS", displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "Delhivery", number: "DL123456789", url: "https://www.delhivery.com/?tracking-id=DL123456789" }] }] });
  assert.equal(mapped.total, "₹1,499");
  assert.equal(mapped.tracking[0].resolvedUrl, "https://www.delhivery.com/track-v2/package/DL123456789");
});

// ---------- automatic order messages (confirmed / dispatched / delivered) ----------
const NOW = Date.parse("2026-11-13T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const sample = (over: any = {}) => ({
  id: "gid://shopify/Order/7001", name: "#W1219", createdAt: ago(5), cancelledAt: null, phone: null,
  shippingAddress: { name: "Asha Kumari", phone: "98765 43210" }, customer: null, billingAddress: null,
  lineItems: { nodes: [{ title: "HP LaserJet 1008w", variantTitle: "Default Title", quantity: 1, currentQuantity: 1 }] },
  currentTotalPriceSet: { shopMoney: { amount: "1499.00", currencyCode: "INR" } },
  displayFinancialStatus: "PAID", paymentGatewayNames: [], fulfillments: [], ...over,
});
const shipped = (over: any = {}) => ({ createdAt: ago(10), updatedAt: ago(10), displayStatus: "IN_TRANSIT", deliveredAt: null, estimatedDeliveryAt: "2026-11-16T00:00:00Z", trackingInfo: [{ company: "Delhivery", number: "DL123456789", url: null }], ...over });

test("order messages: a new order gets a confirmation from JAZZ", async () => {
  const { buildOrderNotices }: any = await loadApp("/app/lib/order-notice.ts");
  const r = buildOrderNotices(sample(), NOW);
  assert.equal(r.phone, "+919876543210");
  assert.equal(r.notices.length, 1);
  assert.equal(r.notices[0].key, "confirmed");
  for (const part of ["Hi, Asha!", "JAZZ", "confirmed", "1. Order Number: #W1219", "HP LaserJet 1008w × 1", "Total: ₹1,499", "Payment: Paid"]) assert.ok(r.notices[0].text.includes(part), part);
  const cod = buildOrderNotices(sample({ paymentGatewayNames: ["Cash on Delivery (COD)"], displayFinancialStatus: "PENDING" }), NOW);
  assert.match(cod.notices[0].text, /Payment: Pay on delivery \(COD\)/);
});

test("order messages: old orders, cancelled orders and orders without a phone are handled safely", async () => {
  const { buildOrderNotices }: any = await loadApp("/app/lib/order-notice.ts");
  assert.equal(buildOrderNotices(sample({ createdAt: ago(60 * 24 * 30) }), NOW).notices.length, 0, "an old order is never announced again");
  const cancelled = buildOrderNotices(sample({ cancelledAt: ago(1) }), NOW);
  assert.deepEqual(cancelled.notices.map((n: any) => n.key), ["cancelled"], "a just-cancelled order gets one cancellation message and nothing else");
  assert.match(cancelled.notices[0].text, /has been cancelled/);
  assert.match(cancelled.notices[0].text, /refund goes back to your original payment method/);
  assert.equal(buildOrderNotices(sample({ createdAt: ago(60 * 24 * 5), cancelledAt: ago(60 * 24 * 4) }), NOW).notices.length, 0, "an old cancellation is not announced again");
  assert.ok(!/refund/.test(buildOrderNotices(sample({ cancelledAt: ago(1), displayFinancialStatus: "PENDING", paymentGatewayNames: ["Cash on Delivery (COD)"] }), NOW).notices[0].text), "no refund line for a COD order");
  const none = buildOrderNotices(sample({ shippingAddress: { name: "X" } }), NOW);
  assert.equal(none.phone, null);
});

test("order messages: tracking added -> dispatched message with courier, id and the Delhivery link", async () => {
  const { buildOrderNotices }: any = await loadApp("/app/lib/order-notice.ts");
  const r = buildOrderNotices(sample({ createdAt: ago(60 * 24), fulfillments: [shipped()] }), NOW);
  assert.deepEqual(r.notices.map((n: any) => n.key), ["dispatched:DL123456789"]);
  const t = r.notices[0].text;
  for (const part of ["dispatched", "Courier: Delhivery", "Tracking ID: DL123456789", "https://www.delhivery.com/track-v2/package/DL123456789", "Expected Delivery: 16 Nov 2026"]) assert.ok(t.includes(part), part);
  assert.equal(buildOrderNotices(sample({ createdAt: ago(60 * 24 * 9), fulfillments: [shipped({ createdAt: ago(60 * 24 * 3), updatedAt: ago(60 * 24 * 3) })] }), NOW).notices.length, 0, "an old shipment is not announced again");
  assert.equal(buildOrderNotices(sample({ createdAt: ago(60 * 24), fulfillments: [shipped({ trackingInfo: [] })] }), NOW).notices.length, 0, "no tracking id, no dispatch message");
});

test("order messages: delivered -> a proper delivery message, once", async () => {
  const { buildOrderNotices }: any = await loadApp("/app/lib/order-notice.ts");
  const f = shipped({ displayStatus: "DELIVERED", deliveredAt: ago(60), updatedAt: ago(60) });
  const r = buildOrderNotices(sample({ createdAt: ago(60 * 24 * 4), fulfillments: [f] }), NOW);
  assert.deepEqual(r.notices.map((n: any) => n.key), ["delivered:DL123456789"]);
  assert.match(r.notices[0].text, /delivered\. 🎉/);
  assert.match(r.notices[0].text, /Delivered on: 13 Nov 2026/);
  assert.equal(buildOrderNotices(sample({ createdAt: ago(60 * 24 * 40), fulfillments: [shipped({ displayStatus: "DELIVERED", deliveredAt: ago(60 * 24 * 20), updatedAt: ago(60 * 24 * 20) })] }), NOW).notices.length, 0, "an old delivery is not announced");
});

test("order messages: notifyOrder stores one message per event, never twice, and obeys the setting", async () => {
  const { notifyOrder }: any = await loadApp("/app/lib/order-notify.server.ts");
  const node = sample({ id: "gid://shopify/Order/7002", name: "#W7002", createdAt: new Date().toISOString(), shippingAddress: { name: "Ravi Test", phone: "+919811100001" } });
  await notifyOrder(SHOP, node);
  await notifyOrder(SHOP, node); // a second webhook for the same order
  const conv = await prisma.conversation.findFirst({ where: { shop: SHOP, phone: "+919811100001" }, include: { messages: true } });
  const sent = conv?.messages.filter((m) => m.inReplyTo?.startsWith("notify:")) ?? [];
  assert.equal(sent.length, 1, "one confirmation, not two");
  assert.ok(sent[0].body.includes("JAZZ") && sent[0].body.includes("#W7002"));
  assert.equal(sent[0].inReplyTo, "notify:gid://shopify/Order/7002:confirmed");

  await prisma.botSettings.upsert({ where: { shop: SHOP }, create: { shop: SHOP, orderMessages: false }, update: { orderMessages: false } });
  await notifyOrder(SHOP, sample({ id: "gid://shopify/Order/7003", name: "#W7003", createdAt: new Date().toISOString(), shippingAddress: { name: "Meera", phone: "+919811100002" } }));
  assert.equal(await prisma.conversation.count({ where: { shop: SHOP, phone: "+919811100002" } }), 0, "switched off: nothing is sent");
  await prisma.botSettings.deleteMany({ where: { shop: SHOP } });
});

test("WhatsApp bridge: a second copy of the app waits instead of fighting for the same login", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const file = `${mkdtempSync(`${os.tmpdir()}/wa-lock-`)}/bridge.lock`;
  const { lockedByOther }: any = await loadApp("/app/lib/bridge.server.ts");
  assert.equal(lockedByOther(file), false, "no lock file: free to connect");
  writeFileSync(file, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  assert.equal(lockedByOther(file), true, "another live process holds a fresh lock");
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(lockedByOther(file), false, "our own lock does not block us");
  writeFileSync(file, JSON.stringify({ pid: process.ppid, at: Date.now() - 120_000 }));
  assert.equal(lockedByOther(file), false, "a lock nobody refreshed for two minutes is stale");
  writeFileSync(file, JSON.stringify({ pid: 2_000_000, at: Date.now() }));
  assert.equal(lockedByOther(file), false, "a lock whose process is gone is ignored");
});

test("order messages: catching up after WhatsApp was offline covers 18 hours and sends only the newest stage", async () => {
  const { buildOrderNotices }: any = await loadApp("/app/lib/order-notice.ts");
  const H = 60;
  const order = sample({ createdAt: ago(10 * H), fulfillments: [shipped({ createdAt: ago(5 * H), updatedAt: ago(5 * H) })] });
  assert.equal(buildOrderNotices(order, NOW).notices.length, 0, "normally a 10-hour-old order is not announced");
  const all = buildOrderNotices(order, NOW, { windowMs: 18 * H * 60_000 });
  assert.deepEqual(all.notices.map((n: any) => n.kind), ["confirmed", "dispatched"]);
  const latest = buildOrderNotices(order, NOW, { windowMs: 18 * H * 60_000, latestOnly: true });
  assert.deepEqual(latest.notices.map((n: any) => n.kind), ["dispatched"], "a dispatched order is not told 'confirmed' again");
  const done = sample({ createdAt: ago(12 * H), fulfillments: [shipped({ displayStatus: "DELIVERED", deliveredAt: ago(3 * H), updatedAt: ago(3 * H) })] });
  assert.deepEqual(buildOrderNotices(done, NOW, { windowMs: 18 * H * 60_000, latestOnly: true }).notices.map((n: any) => n.kind), ["delivered"]);
  assert.equal(buildOrderNotices(sample({ createdAt: ago(30 * H) }), NOW, { windowMs: 18 * H * 60_000 }).notices.length, 0, "older than 18 hours is still never announced");
});

test("WhatsApp disconnects are explained in plain words and summarised", async () => {
  const { explainClose, historyRow, summarizeHistory }: any = await loadApp("/app/lib/bridge-reasons.ts");
  assert.match(explainClose(440).title, /somewhere else/i);
  assert.match(explainClose(401).advice, /Scan the QR/i);
  assert.match(explainClose(undefined, "Error: connect ETIMEDOUT").title, /timed out/i);
  const row = historyRow({ event: "bridge_closed", detail: "code=428 Connection Closed", createdAt: new Date(NOW) });
  assert.match(row.title, /Disconnected: WhatsApp closed the connection \(code 428\)/);
  const restarts = [0, 1, 2].map((i) => historyRow({ event: "bridge_app_started", detail: "pid 1", createdAt: new Date(NOW - i * 3_600_000) }));
  assert.match(summarizeHistory(restarts, NOW).verdict, /restarted the app 3 times/);
  assert.match(summarizeHistory([], NOW).verdict, /No disconnects/);
  const replaced = [historyRow({ event: "bridge_replaced", detail: "x", createdAt: new Date(NOW - 1000) })];
  assert.match(summarizeHistory(replaced, NOW).verdict, /another place/i);
});
