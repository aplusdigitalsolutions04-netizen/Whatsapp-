/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { billingCsv, extractGst, orderToRows, parseOrderIds, plainPhone, BILLING_COLUMNS } from "../app/lib/billing-data.ts";
import { closeApp, loadApp } from "./helpers/load-app.ts";

after(async () => {
  await closeApp();
});

const order = (name: string, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Order/${name.replace(/\D/g, "")}`,
  name,
  createdAt: "2026-11-13T20:30:00Z",
  email: "asha@example.com",
  phone: "+919876543210",
  note: null,
  currentTotalPriceSet: { shopMoney: { amount: "11398.0", currencyCode: "INR" } },
  customAttributes: [],
  customer: { firstName: "Asha", lastName: "Kumar" },
  shippingAddress: { name: "Asha Kumar", company: "", address1: "12 MG Road", address2: "Flat 4", city: "Pune", province: "Maharashtra", zip: "411001", country: "India", phone: null },
  billingAddress: { name: "Asha Kumar", company: "", address1: "12 MG Road", city: "Pune", province: "Maharashtra", zip: "411001", country: "India" },
  lineItems: {
    nodes: [
      { title: "HP LaserJet 1008w", variantTitle: "Default Title", quantity: 1, discountedUnitPriceSet: { shopMoney: { amount: "10999.0", currencyCode: "INR" } }, taxLines: [{ title: "IGST", rate: 0.18, ratePercentage: 18, priceSet: { shopMoney: { amount: "1677.81" } } }] },
      { title: "USB Cable", variantTitle: "2 m", quantity: 2, discountedUnitPriceSet: { shopMoney: { amount: "199.5", currencyCode: "INR" } }, taxLines: [] },
    ],
  },
  ...over,
});

test("order ids: any separator, with or without #, no duplicates, order kept", () => {
  assert.deepEqual(parseOrderIds("#W1219\n#W1220, W1221;  1222 | #w1219"), ["#W1219", "#W1220", "W1221", "1222"]);
  assert.deepEqual(parseOrderIds("  \n , "), []);
  assert.deepEqual(parseOrderIds("##W1"), ["#W1"]);
});

test("billing rows: one row per item with every requested detail", () => {
  const rows = orderToRows(order("#W1219"));
  assert.equal(rows.length, 2, "two items, two rows");
  const [a, b] = rows;
  assert.equal(a.orderId, "#W1219");
  assert.equal(a.orderDate, "14 Nov 2026", "shown in India time (20:30 UTC is already the next day there)");
  assert.equal(a.customerName, "Asha Kumar");
  assert.equal(a.phone, "9876543210", "+91 removed so Excel keeps the number");
  assert.equal(a.email, "asha@example.com");
  assert.equal(a.address, "12 MG Road, Flat 4, Pune, Maharashtra, 411001, India");
  assert.equal(a.itemName, "HP LaserJet 1008w");
  assert.equal(a.quantity, 1);
  assert.equal(a.price, "10999.00");
  assert.equal(a.gstPercent, "18");
  assert.equal(a.gstAmount, "1677.81");
  assert.equal(b.itemName, "USB Cable (2 m)", "variant is part of the item name unless it is Default Title");
  assert.equal(b.quantity, 2);
  assert.equal(b.price, "199.50");
  assert.equal(b.gstAmount, "", "no tax line: empty, not 0");
  assert.equal(b.orderId, a.orderId, "order details repeat on every item row");
  assert.equal(a.totalAmount, "11398.00", "the order total is on every row");
  assert.equal(b.totalAmount, "11398.00");
  assert.equal(BILLING_COLUMNS[BILLING_COLUMNS.length - 1].key, "totalAmount", "Total Amount is the last column");
  assert.equal(orderToRows(order("#W9", { currentTotalPriceSet: null }))[0].totalAmount, "", "no total known: empty");
});

test("billing rows: falls back to billing address, customer name and the address phone", () => {
  const rows = orderToRows(order("#W2", { phone: null, shippingAddress: null, customer: { firstName: "Ravi", lastName: "S" }, billingAddress: { name: "", address1: "Shop 5", city: "Delhi", phone: "+91 98111 11111" } }));
  assert.equal(rows[0].customerName, "Ravi S");
  assert.equal(rows[0].address, "Shop 5, Delhi");
  assert.equal(rows[0].phone, "9811111111");
  assert.equal(orderToRows(order("#W3", { lineItems: { nodes: [] } })).length, 1, "an order without items still gives one row");
});

test("GST number: checkout field, order note or address company; company name from the address", () => {
  const G = "27ABCDE1234F1Z5";
  assert.equal(extractGst(order("#1", { customAttributes: [{ key: "GST Number", value: G.toLowerCase() }] })).gstNumber, G, "from the checkout field, upper-cased");
  assert.equal(extractGst(order("#2", { note: `Please invoice. GSTIN: ${G} thanks` })).gstNumber, G, "found inside the order note");
  assert.equal(extractGst(order("#3", { billingAddress: { company: `Acme Traders ${G}` } })).gstNumber, G);
  assert.equal(extractGst(order("#4")).gstNumber, "", "none given");
  assert.equal(extractGst(order("#5", { billingAddress: { company: "Acme Traders" } })).companyName, "Acme Traders");
  assert.equal(extractGst(order("#6", { customAttributes: [{ key: "Company Name", value: "Beta Ltd" }] })).companyName, "Beta Ltd");
});

test("GST: a Yes / No answer is never taken as the number; the real number is fetched when there is one", () => {
  const G = "27ABCDE1234F1Z5";
  // "GST: Yes" and a separate field for the number
  const yes = extractGst(order("#1", { customAttributes: [{ key: "GST", value: "Yes" }, { key: "GST Number", value: G }] }));
  assert.deepEqual([yes.hasGst, yes.gstNumber], ["Yes", G]);
  // the number field comes first, the question after
  const swapped = extractGst(order("#2", { customAttributes: [{ key: "Enter GST number", value: G }, { key: "Do you have GST?", value: "yes" }] }));
  assert.deepEqual([swapped.hasGst, swapped.gstNumber], ["Yes", G]);
  // only the question, answered Yes: no number to show (never "YES" as a number)
  const onlyYes = extractGst(order("#3", { customAttributes: [{ key: "GST", value: "Yes" }] }));
  assert.deepEqual([onlyYes.hasGst, onlyYes.gstNumber], ["Yes", ""]);
  // answered No
  const no = extractGst(order("#4", { customAttributes: [{ key: "GST", value: "No" }] }));
  assert.deepEqual([no.hasGst, no.gstNumber], ["No", ""]);
  // Hindi / Hinglish answers
  assert.equal(extractGst(order("#5", { customAttributes: [{ key: "GST", value: "हाँ" }] })).hasGst, "Yes");
  assert.equal(extractGst(order("#6", { customAttributes: [{ key: "GST", value: "nahi" }] })).hasGst, "No");
  // a number typed with spaces / dashes / lower case is cleaned; the wrong format is still shown as typed
  assert.equal(extractGst(order("#7", { customAttributes: [{ key: "GSTIN", value: "27abcde 1234f-1z5" }] })).gstNumber, G);
  assert.equal(extractGst(order("#8", { customAttributes: [{ key: "GST No", value: "27ABC123" }] })).gstNumber, "27ABC123");
  // nothing asked
  assert.deepEqual(Object.values(extractGst(order("#9"))), ["", "", ""]);
});

test("phones: Indian numbers become 10 digits, others stay as they are", () => {
  assert.equal(plainPhone("+919211890093"), "9211890093");
  assert.equal(plainPhone("09211890093"), "9211890093");
  assert.equal(plainPhone("92118 90093"), "9211890093");
  assert.equal(plainPhone("+447911123456"), "+447911123456");
  assert.equal(plainPhone(""), "");
});

test("CSV: header, one line per row, quotes and commas escaped, Excel formulas defused, BOM for Hindi", () => {
  const rows = orderToRows(order("#W1219", { shippingAddress: { name: "आशा, \"A\" Kumar", address1: "=cmd|calc", city: "Pune" } }));
  const csv = billingCsv(rows);
  assert.ok(csv.startsWith(String.fromCharCode(0xfeff) + BILLING_COLUMNS.map((c) => c.label).join(",") + "\r\n"));
  assert.ok(csv.includes('"आशा, ""A"" Kumar"'));
  assert.ok(csv.includes("\"'=cmd|calc, Pune\"") || csv.includes("'=cmd|calc, Pune"), "a cell starting with = is made harmless");
  assert.equal(csv.trimEnd().split("\r\n").length, 1 + rows.length);
  for (const label of ["Order ID", "Order Date", "Customer Full Name", "Phone No", "Email", "Address", "GST Number", "Item Name", "Quantity"]) assert.ok(csv.includes(label), label);
});

test("fetching: only the typed orders are asked for, in one search, and missing / invalid ids are reported", async () => {
  const { fetchBillingOrders }: any = await loadApp("/app/lib/billing-data.server.ts");
  const calls: { query: string; vars: any }[] = [];
  const run = async (_shop: string, query: string, vars: any = {}) => {
    calls.push({ query, vars });
    if (query.includes("orderNumberFormatPrefix")) return { shop: { orderNumberFormatPrefix: "W" } };
    const q = String(vars.q);
    const all = [order("#W1219"), order("#W1220"), order("#W9999")];
    return { orders: { nodes: all.filter((o) => q.includes(`name:${o.name}`)) } };
  };
  const r = await fetchBillingOrders("shop.invalid", "#W1219, 1220 W5555 hello #W1219", run);
  assert.deepEqual(r.found, ["#W1219", "#W1220"], "found in the order typed; the duplicate is ignored; 1220 got the store letter");
  assert.deepEqual(r.missing, ["W5555"]);
  assert.deepEqual(r.invalid, ["hello"]);
  assert.equal(r.rows.length, 4, "two orders x two items");
  const searches = calls.filter((c) => !c.query.includes("orderNumberFormatPrefix"));
  assert.equal(searches.length, 1, "one search for all typed ids, not one per order");
  assert.ok(!String(searches[0].vars.q).includes("W9999"), "an order nobody asked for is never requested");
});

test("fetching: more than 100 ids are cut off and the rest is listed", async () => {
  const { fetchBillingOrders, MAX_BILLING_ORDERS }: any = await loadApp("/app/lib/billing-data.server.ts");
  const ids = Array.from({ length: MAX_BILLING_ORDERS + 3 }, (_, i) => `#W${1000 + i}`).join(" ");
  const r = await fetchBillingOrders("shop.invalid", ids, async () => ({ orders: { nodes: [] } }));
  assert.equal(r.skipped.length, 3);
  assert.equal(r.missing.length, MAX_BILLING_ORDERS);
});
