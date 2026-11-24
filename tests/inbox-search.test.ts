/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { highlightParts, last10, phoneNeedle, snippetAround } from "../app/lib/inbox-search.ts";
import { closeApp, loadApp } from "./helpers/load-app.ts";

const SHOP = "inbox-search-test.invalid"; // isolated shop; its rows are removed afterwards
after(async () => {
  const convs = await prisma.conversation.findMany({ where: { shop: SHOP }, select: { id: true } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await prisma.conversation.deleteMany({ where: { shop: SHOP } });
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  await closeApp();
});

test("search text: phone numbers in any format, snippets and highlights", () => {
  for (const t of ["+91 98765 43210", "09876543210", "9876543210", "98765-43210", "919876543210"]) assert.equal(phoneNeedle(t), "9876543210", t);
  assert.equal(phoneNeedle("1219"), null, "an order number is not a phone number");
  assert.equal(phoneNeedle("#W1219"), null);
  assert.equal(phoneNeedle("asha"), null);
  assert.equal(phoneNeedle("987654"), "987654", "part of a number still works (6+ digits)");
  assert.equal(last10("+91 98765 43210"), "9876543210");

  const body = "Hello, I want a refund for my printer order because the paper tray is broken and nobody replied for three days now";
  const s = snippetAround(body, "refund");
  assert.ok(s.includes("refund") && s.length <= 75, s);
  assert.equal(snippetAround("short text", "zzz"), "short text");
  assert.deepEqual(highlightParts("Order #W1219 is late, w1219!", "w1219").map((p) => [p.text, p.hit]), [["Order #", false], ["W1219", true], [" is late, ", false], ["w1219", true], ["!", false]]);
  assert.deepEqual(highlightParts("abc", ""), [{ text: "abc", hit: false }]);
});

test("inbox search: number, name, ORDER ID and message words; best match first; filters respected", async () => {
  const { searchInbox }: any = await loadApp("/app/lib/inbox-search.server.ts");
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const chat = async (phone: string, name: string | null, minutesAgo: number, msgs: string[], channel = "whatsapp") => {
    const c = await prisma.conversation.create({ data: { shop: SHOP, phone, customerName: name, lastMessageAt: at(minutesAgo), channel } });
    for (const [i, body] of msgs.entries()) await prisma.message.create({ data: { conversationId: c.id, direction: "in", sender: "customer", body, status: "received", createdAt: at(minutesAgo - i) } });
    return c;
  };
  const asha = await chat("+919876543210", "Asha Kumar", 50, ["hi", "when will it come"]); // placed #W1219; never wrote the order id
  const ravi = await chat("+919811100001", "Ravi", 40, ["my order #W1219 is wrong?", "refund please"]); // wrote the order id of someone else's order
  const meera = await chat("+919822200002", "Meera Shah", 30, ["where is my parcel"]);
  const web = await chat("web:abcdefghij0123456789", null, 20, ["order 1219 status"], "web");
  await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: "s1", orderName: "#W1219", primaryMobile: "98765 43210", status: "Delivered" } });
  await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: "s2", orderName: "#W1300", primaryMobile: "+91 98222 00002", altMobile: null, status: "Delivered" } });
  const base = { shop: SHOP };
  const ids = (r: any[]) => r.map((x) => x.c.id);

  // phone number, any way typed
  for (const t of ["98765 43210", "+91 98765 43210", "09876543210", "987654"]) assert.deepEqual(ids(await searchInbox(SHOP, t, base)), [asha.id], t);

  // name (any case) and a part of the name
  assert.deepEqual(ids(await searchInbox(SHOP, "ASHA", base)), [asha.id]);
  assert.equal((await searchInbox(SHOP, "shah", base))[0].match.kind, "name");

  // order id: the customer who placed it comes FIRST (even though the id is not in her messages), then chats where the id was written
  for (const t of ["#W1219", "W1219", "w1219", "1219"]) {
    const r = await searchInbox(SHOP, t, base);
    assert.equal(r[0].c.id, asha.id, `${t}: the customer of order #W1219 is on top`);
    assert.deepEqual(r[0].match, { kind: "order", order: "#W1219" }, t);
    assert.ok(ids(r).includes(ravi.id), `${t}: a chat that mentions the order id is found too`);
  }
  assert.equal((await searchInbox(SHOP, "W1219", base)).find((x: any) => x.c.id === ravi.id).match.kind, "message");
  assert.deepEqual(ids(await searchInbox(SHOP, "#W1300", base)), [meera.id], "another order, another customer");

  // a word inside a message, with the matching text shown
  const refund = await searchInbox(SHOP, "refund", base);
  assert.deepEqual(ids(refund), [ravi.id]);
  assert.ok(refund[0].match.snippet.includes("refund"));

  // order > number > name > message; newest first inside the same kind
  await prisma.message.create({ data: { conversationId: meera.id, direction: "in", sender: "customer", body: "my number is 9876543210", status: "received" } });
  await prisma.conversation.update({ where: { id: meera.id }, data: { customerName: "9876" } });
  const mixed = await searchInbox(SHOP, "9876543210", base);
  assert.deepEqual(mixed.map((x: any) => x.match.kind), ["phone", "message"], "the chat with that number first, the chat that only mentions it after");
  await prisma.message.deleteMany({ where: { conversationId: meera.id, body: "my number is 9876543210" } });

  // the chosen tab / filter still applies; nothing found gives an empty list
  assert.deepEqual(ids(await searchInbox(SHOP, "1219", { shop: SHOP, channel: "web" })), [web.id]);
  assert.deepEqual(ids(await searchInbox(SHOP, "1219", { shop: SHOP, channel: "whatsapp" })).includes(web.id), false);
  assert.deepEqual(await searchInbox(SHOP, "zzzz-nothing", base), []);
  assert.ok((await searchInbox(SHOP, "12", base)).every((x: any) => x.match.kind === "message"), "two digits are never taken as a phone number (they only match message text)");
  assert.deepEqual(ids(await searchInbox("some-other-shop.invalid", "asha", { shop: "some-other-shop.invalid" })), [], "never another shop's chats");
});
