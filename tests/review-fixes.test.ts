/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { closeApp, loadApp } from "./helpers/load-app.ts";

const SHOP = "review-fixes-test.invalid"; // isolated shop; its rows are removed afterwards
after(async () => {
  const convs = await prisma.conversation.findMany({ where: { shop: SHOP }, select: { id: true } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await prisma.conversation.deleteMany({ where: { shop: SHOP } });
  await prisma.imsPush.deleteMany({ where: { shop: SHOP } });
  await prisma.imsConfig.deleteMany({ where: { shop: SHOP } });
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.botSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.activityLog.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  await closeApp();
});

test("IMS safety net: still finds a missed NEW order when more than 300 orders have come in since the switch", async () => {
  const s: any = await loadApp("/app/lib/ims-push.server.ts");
  await prisma.imsConfig.create({ data: { shop: SHOP, enabled: true, url: "https://ims.example.com/api/x", keyEnc: "x", autoFrom: new Date(Date.now() - 3_600_000) } });
  const base = Date.now() - 1_800_000;
  for (let i = 0; i < 320; i++) {
    await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: String(100000 + i), orderName: `#W${100000 + i}`, orderDate: new Date(base + i * 1000), createdAt: new Date(base + i * 1000), status: "Unfulfilled" } });
  }
  // the first 300 reached the outbox; the 20 newest did not
  await prisma.imsPush.createMany({ data: Array.from({ length: 300 }, (_, i) => ({ shop: SHOP, orderGid: `gid://shopify/Order/${100000 + i}`, status: "sent" })) });
  assert.equal(await s.enqueueMissedOrders(SHOP), 20, "the 20 newest orders are found and queued");
  assert.equal(await s.enqueueMissedOrders(SHOP), 0);
  const queued = await prisma.imsPush.findMany({ where: { shop: SHOP, status: "pending" }, orderBy: { nextAttemptAt: "asc" } });
  assert.deepEqual(queued.map((q) => q.orderGid), Array.from({ length: 20 }, (_, i) => `gid://shopify/Order/${100300 + i}`), "queued oldest first");
});

test("web chat: one visitor cannot fill the Live Inbox with fake chats; a chat that already exists keeps working", async () => {
  const web: any = await loadApp("/app/lib/web-chat.server.ts");
  await prisma.botSettings.upsert({ where: { shop: SHOP }, create: { shop: SHOP, webWidget: true }, update: { webWidget: true } });
  const ip = "203.0.113.7";
  const sid = (n: number) => `limitvisitor_abcdefgh${String(n).padStart(4, "0")}`;
  const results: number[] = [];
  for (let n = 0; n < 8; n++) {
    const r = await web.sendWebMessage({ shop: SHOP, sid: sid(n), text: "hi", ip });
    results.push(r.ok ? 200 : r.status);
  }
  assert.deepEqual(results, [200, 200, 200, 200, 200, 200, 429, 429], "6 new chats a minute from one address, then 'too many new chats'");
  assert.equal(await prisma.conversation.count({ where: { shop: SHOP, phone: { startsWith: "web:limitvisitor" } } }), 6, "the refused ones did not create a chat");
  const again = await web.sendWebMessage({ shop: SHOP, sid: sid(0), text: "one more question", ip });
  assert.equal(again.ok, true, "an existing chat continues normally");
  const other = await web.sendWebMessage({ shop: SHOP, sid: sid(50), text: "hi", ip: "198.51.100.9" });
  assert.equal(other.ok, true, "another visitor (another address) is not affected");
});

test("Live Inbox search: words inside messages need 2 characters; one character searches names and numbers only", async () => {
  const { searchInbox }: any = await loadApp("/app/lib/inbox-search.server.ts");
  const c = await prisma.conversation.create({ data: { shop: SHOP, phone: "+919800011122", customerName: "Meera", lastMessageAt: new Date() } });
  await prisma.message.create({ data: { conversationId: c.id, direction: "in", sender: "customer", body: "zebra please", status: "received" } });
  const base = { shop: SHOP, id: c.id };
  assert.deepEqual(await searchInbox(SHOP, "z", base), [], "one letter does not scan the messages");
  assert.equal((await searchInbox(SHOP, "ze", base)).length, 1, "two letters do");
  assert.equal((await searchInbox(SHOP, "m", base)).length, 1, "one letter still finds a name");
});
