import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { dayKey, loadDashboardData } from "../app/lib/dashboard-data.server.ts";

const SHOP = "dashboard-test.invalid"; // isolated shop; everything is removed afterwards
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

after(async () => {
  await prisma.conversation.deleteMany({ where: { shop: SHOP } }); // messages cascade
  await prisma.productEnquiry.deleteMany({ where: { shop: SHOP } });
  await prisma.activityLog.deleteMany({ where: { shop: SHOP } });
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.imageJob.deleteMany({ where: { shop: SHOP } }); // items cascade
  await prisma.$disconnect();
});

test("dashboard numbers come straight from the stored records", async () => {
  const now = Date.now();
  const base = await loadDashboardData(SHOP, 7, now); // activity logs are global: compare against this baseline
  assert.equal(base.kpi.customers.value, 0);
  assert.equal(base.orders.total, 0);

  const at = (ms: number) => new Date(now - ms);
  const mk = (phone: string, mode: string, status: string) =>
    prisma.conversation.create({ data: { shop: SHOP, phone, mode, status, handoffReason: mode === "human" ? "Customer requested a human agent" : null, lastInboundAt: at(HOUR) } });
  const a = await mk("+910000000001", "human", "open");
  const b = await mk("+910000000002", "bot", "open");
  await mk("+910000000003", "bot", "closed");

  const msg = (conversationId: string, direction: string, sender: string, status: string, ago: number) =>
    prisma.message.create({ data: { conversationId, direction, sender, status, body: "x", createdAt: at(ago) } });
  await msg(a.id, "in", "customer", "received", HOUR);
  await msg(a.id, "in", "customer", "received", 2 * HOUR);
  await msg(a.id, "out", "agent", "read", HOUR);
  for (let i = 0; i < 3; i++) await msg(b.id, "in", "customer", "received", 3 * HOUR);
  await msg(b.id, "out", "bot", "delivered", 3 * HOUR);
  await msg(b.id, "out", "bot", "read", 3 * HOUR);
  await msg(b.id, "out", "bot", "failed", 3 * HOUR);
  await msg(b.id, "out", "bot", "sent", 3 * HOUR);
  await msg(b.id, "in", "customer", "received", 10 * DAY); // previous period (days 8-14)

  const enq = (query: string, found: boolean, ago: number) => prisma.productEnquiry.create({ data: { shop: SHOP, phone: "+910000000001", query, found, createdAt: at(ago) } });
  await enq("printer", true, HOUR);
  await enq("Printer", true, 2 * HOUR);
  await enq("printer", true, 3 * HOUR);
  await enq("gaming chair", false, HOUR);
  await enq("Gaming Chair", false, 5 * HOUR);
  await enq("old thing", false, 10 * DAY);

  const log = (event: string) => prisma.activityLog.create({ data: { shop: SHOP, source: "bot", event, createdAt: at(HOUR) } });
  await log("handoff");
  await log("handoff");
  await log("order_retrieved");

  const order = (id: string, status: string, callStatus: string | null, paymentType: string, amount: number, ago: number) =>
    prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: id, orderName: `#${id}`, status, callStatus, paymentType, amount, currency: "INR", orderDate: at(ago) } });
  await order("1", "Unfulfilled", null, "COD", 1000, DAY);
  await order("2", "Unfulfilled", "Connected", "Prepaid", 2000, 2 * DAY);
  await order("3", "Delivered", "Connected", "COD", 500, 12 * DAY); // previous period
  await order("4", "RTO", null, "COD", 700, 20 * DAY); // outside both windows

  const d = await loadDashboardData(SHOP, 7, now);

  // conversations and messages
  assert.deepEqual(d.conversations, { human: 1, bot: 1, closed: 1 });
  assert.equal(d.kpi.customers.value, 2);
  assert.equal(d.kpi.received.value, 5);
  assert.equal(d.kpi.received.prev, 1);
  assert.equal(d.kpi.received.change, 400);
  assert.equal(d.kpi.replies.value, 5);
  assert.deepEqual([d.kpi.automation.bot, d.kpi.automation.agent, d.kpi.automation.value], [4, 1, 80]);
  assert.equal(d.kpi.deliveryRate, 60); // delivered + read out of 5 sent
  assert.equal(d.pending.failedMessages, 1);
  assert.equal(d.waiting.length, 1);
  assert.equal(d.waiting[0].reason, "Customer requested a human agent");

  // enquiries (same product typed in different case counts together)
  assert.equal(d.kpi.enquiries.value, 5);
  assert.equal(d.kpi.enquiries.prev, 1);
  assert.equal(d.kpi.enquiries.found, 3);
  assert.equal(d.kpi.enquiries.availability, 60);
  assert.equal(d.products.wanted[0].count, 3);
  assert.equal(d.products.wanted[0].found, 3);
  assert.deepEqual(d.products.unavailable.map((p) => [p.query.toLowerCase(), p.count]), [["gaming chair", 2]]);

  // bot activity
  assert.equal(d.kpi.handoffs.value - base.kpi.handoffs.value, 2);
  assert.equal(d.kpi.ordersShared.value - base.kpi.ordersShared.value, 1);

  // orders
  assert.equal(d.orders.total, 4);
  assert.deepEqual(d.orders.status, { Unfulfilled: 2, Fulfilled: 0, Delivered: 1, Cancelled: 0, RTO: 1 });
  assert.equal(d.pending.uncalled, 1);
  assert.equal(d.orders.uncalledList[0].name, "#1");
  assert.deepEqual(d.orders.calls.map((c) => [c.status, c.count]).sort(), [["Connected", 1], ["Not called yet", 1]]);
  assert.equal(d.kpi.newOrders.value, 2);
  assert.equal(d.kpi.newOrders.prev, 1);
  assert.equal(d.kpi.newOrders.amount, 3000);
  assert.equal(d.kpi.newOrders.currency, "INR");
  assert.deepEqual(d.orders.payment.map((p) => [p.type, p.count]).sort(), [["COD", 3], ["Prepaid", 1]]);

  // charts: one bucket per day, the totals match the KPIs, and today's bucket is the last one
  assert.equal(d.days.length, 7);
  assert.equal(d.days[6].day, dayKey(new Date(now)));
  assert.equal(d.days.reduce((n, x) => n + x.incoming, 0), 5);
  assert.equal(d.days.reduce((n, x) => n + x.found + x.missing, 0), 5);
  assert.equal(d.hours.reduce((n, x) => n + x.count, 0), 5);
});

test("Image Editor numbers on the dashboard come from the stored batches", async () => {
  const now = Date.now();
  const at = (ms: number) => new Date(now - ms);
  const job = await prisma.imageJob.create({ data: { id: `dash-${now}`, shop: SHOP, name: "Summer shoes", status: "running", total: 6 } });
  const item = (status: string, ago: number, inBytes: number, outBytes: number, ms: number) =>
    prisma.imageItem.create({ data: { jobId: job.id, shop: SHOP, name: "a.jpg", status, inBytes, outBytes, ms, finishedAt: status === "queued" ? null : at(ago) } });
  await item("done", HOUR, 1000, 400, 2000);
  await item("done", 2 * HOUR, 3000, 600, 4000);
  await item("error", 3 * HOUR, 500, 0, 0);
  await item("done", 10 * DAY, 800, 400, 1000); // previous period
  await item("queued", 0, 700, 0, 0);
  await item("queued", 0, 700, 0, 0);
  await prisma.imageSettings.upsert({ where: { shop: SHOP }, create: { shop: SHOP, workers: 6 }, update: { workers: 6 } });

  const d = await loadDashboardData(SHOP, 7, now);
  const im = d.images;
  assert.equal(im.done.value, 2);
  assert.equal(im.done.prev, 1);
  assert.equal(im.done.change, 100);
  assert.equal(im.failed, 1);
  assert.equal(im.savedPercent, 75); // 4000 bytes in, 1000 out
  assert.equal(im.avgSeconds, 3);
  assert.equal(im.batches, 1);
  assert.equal(im.everUsed, true);
  assert.equal(im.failedOpen, 1);
  assert.equal(im.savedWorkers, 6);
  assert.deepEqual(im.active && [im.active.name, im.active.done, im.active.failed, im.active.waiting, im.active.total], ["Summer shoes", 3, 1, 2, 6]);
  assert.equal(im.days.reduce((n, x) => n + x.done, 0), 2);
  assert.equal(im.days.reduce((n, x) => n + x.failed, 0), 1);
  assert.equal(d.pending.imageFailed, 1);
});

test("sales, bot sources and IMS numbers on the dashboard", async () => {
  const now = Date.now();
  const at = (ms: number) => new Date(now - ms);
  const log = (event: string, detail: string) => prisma.activityLog.create({ data: { shop: SHOP, source: "bot", event, detail, createdAt: at(HOUR) } });
  const before = await loadDashboardData(SHOP, 7, now); // earlier tests already logged one order lookup
  await log("order_retrieved", "#1 (shopify)");
  await log("order_retrieved", "#7001 (ims)");
  await log("order_retrieved", "#7002 (ims)");
  await log("order_lookup_failed", "ims: offline");
  await log("ims_send", "Billing -> +91****");

  const d = await loadDashboardData(SHOP, 7, now);
  assert.equal(d.ims.lookupsIms, 2);
  assert.equal(d.ims.lookupsShopify - before.ims.lookupsShopify, 1);
  assert.equal(d.ims.lookupFailures, 1);
  assert.equal(d.ims.sent.value, 1);
  assert.equal(d.bot.answers[0].value - before.bot.answers[0].value, 3, "order lookups from both systems");
  assert.equal(d.kpi.revenue.value, 3000);
  assert.equal(d.kpi.revenue.prev, 500);
  assert.equal(d.kpi.avgOrder, 1500);
  assert.equal(d.days.reduce((n, x) => n + x.orders, 0), 2);
  assert.equal(d.days.reduce((n, x) => n + x.revenue, 0), 3000);
  assert.equal(d.orders.rtoRate, 25);
});
