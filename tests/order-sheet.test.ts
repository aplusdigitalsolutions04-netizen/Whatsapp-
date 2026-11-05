import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { computeStatus, mapShopifyOrder } from "../app/lib/order-map.ts";
import { statusCounts, upsertOrder } from "../app/lib/order-store.server.ts";

const SHOP = "order-sheet-test.invalid"; // isolated shop; its rows are removed afterwards
after(async () => {
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
});

const node = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/1001", legacyResourceId: "1001", name: "#1001",
  createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", cancelledAt: null, phone: null, tags: [],
  displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", returnStatus: "NO_RETURN",
  paymentGatewayNames: ["Cash on Delivery (COD)"],
  currentTotalPriceSet: { shopMoney: { amount: "1499.0", currencyCode: "INR" } },
  customer: { firstName: "Asha", lastName: "Rao", defaultPhoneNumber: { phoneNumber: "+919811111111" } },
  shippingAddress: { name: "Asha Rao", address1: "12 MG Road", address2: "Near Metro", city: "Pune", province: "Maharashtra", zip: "411001", phone: "+919822222222" },
  billingAddress: { name: "Asha Rao", phone: null }, shippingLine: { originalPriceSet: { shopMoney: { amount: "60.0" } } },
  lineItems: { nodes: [{ title: "HP Printer", variantTitle: "Default Title", quantity: 1, currentQuantity: 1 }] },
  fulfillments: [], ...over,
});

test("status: fulfilled is not delivered, unfulfilled is not cancelled", () => {
  assert.equal(computeStatus(node()).status, "Unfulfilled");
  assert.match(computeStatus(node()).remarks, /Payment pending/);
  const fulfilled = { displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "IN_TRANSIT", createdAt: "2026-11-02T00:00:00Z" }] };
  assert.equal(computeStatus(node(fulfilled)).status, "Fulfilled");
  assert.equal(computeStatus(node({ ...fulfilled, fulfillments: [{ displayStatus: "DELIVERED" }] })).status, "Delivered");
  assert.equal(computeStatus(node({ displayFulfillmentStatus: "PARTIALLY_FULFILLED" })).status, "Unfulfilled");
  assert.equal(computeStatus(node({ cancelledAt: "2026-11-02T00:00:00Z", displayFulfillmentStatus: "FULFILLED" })).status, "Cancelled");
  assert.equal(computeStatus(node({ tags: ["RTO"], displayFulfillmentStatus: "FULFILLED" })).status, "RTO");
  assert.equal(computeStatus(node({ returnStatus: "RETURNED" })).status, "RTO");
});

test("mapping: COD, quantities, address, alternate mobile", () => {
  const m = mapShopifyOrder(node());
  assert.equal(m.shopifyOrderId, "1001");
  assert.equal(m.paymentType, "COD");
  assert.equal(m.fullAddress, "12 MG Road, Near Metro");
  assert.equal(m.primaryMobile, "+919822222222");
  assert.equal(m.altMobileShopify, "+919811111111");
  assert.equal(m.amount, 1499);
  const edited = mapShopifyOrder(node({ lineItems: { nodes: [{ title: "HP Printer", quantity: 3, currentQuantity: 2 }, { title: "Removed", quantity: 1, currentQuantity: 0 }] } }));
  assert.equal(edited.qty, 2);
  assert.equal(edited.productName, "HP Printer");
});

test("the same order fetched many times, even at once, is one row; employee data survives; old snapshots are ignored", async () => {
  const m = mapShopifyOrder(node());
  // webhook + scheduled sync + retries racing each other
  const results = await Promise.all(Array.from({ length: 12 }, () => upsertOrder(SHOP, m)));
  assert.equal(results.filter((r) => r === "created").length, 1);
  assert.equal(await prisma.orderSheet.count({ where: { shop: SHOP, shopifyOrderId: "1001" } }), 1);

  const row = await prisma.orderSheet.findFirstOrThrow({ where: { shop: SHOP } });
  await prisma.orderSheet.update({
    where: { id: row.id },
    data: { employeeRemark: "Customer will pay on delivery", employeeName: "Ravi", callStatus: "Connected", altMobile: "9000000000", callDate: new Date("2026-11-02") },
  });

  // Shopify changes address, quantity, amount, then fulfils the order
  const changed = mapShopifyOrder(node({
    updatedAt: "2026-11-03T09:00:00Z", displayFulfillmentStatus: "FULFILLED",
    shippingAddress: { name: "Asha Rao", address1: "99 New Street", address2: null, city: "Mumbai", province: "Maharashtra", zip: "400001", phone: "+919822222222" },
    lineItems: { nodes: [{ title: "HP Printer", quantity: 2, currentQuantity: 2 }] },
    currentTotalPriceSet: { shopMoney: { amount: "2998.0", currencyCode: "INR" } },
    fulfillments: [{ displayStatus: "IN_TRANSIT", createdAt: "2026-11-03T08:00:00Z", trackingInfo: [{ company: "Delhivery", number: "AWB123" }] }],
  }));
  assert.equal(await upsertOrder(SHOP, changed), "updated");
  const after1 = await prisma.orderSheet.findFirstOrThrow({ where: { shop: SHOP } });
  assert.equal(after1.city, "Mumbai");
  assert.equal(after1.qty, 2);
  assert.equal(after1.amount, 2998);
  assert.equal(after1.status, "Fulfilled");
  assert.equal(after1.trackingNo, "AWB123");
  assert.equal(after1.employeeRemark, "Customer will pay on delivery");
  assert.equal(after1.employeeName, "Ravi");
  assert.equal(after1.callStatus, "Connected");
  assert.equal(after1.altMobile, "9000000000");
  assert.equal(after1.callDate?.toISOString().slice(0, 10), "2026-11-02");

  // a delayed, older webhook must not roll the order back
  assert.equal(await upsertOrder(SHOP, m), "skipped");
  assert.equal((await prisma.orderSheet.findFirstOrThrow({ where: { shop: SHOP } })).city, "Mumbai");

  // delivered, then cancelled-style transitions keep updating the same row
  await upsertOrder(SHOP, mapShopifyOrder(node({ updatedAt: "2026-11-04T09:00:00Z", displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "DELIVERED" }] })));
  assert.equal((await prisma.orderSheet.findFirstOrThrow({ where: { shop: SHOP } })).status, "Delivered");
  assert.equal(await prisma.orderSheet.count({ where: { shop: SHOP } }), 1);
});

test("counters count each order once and follow status changes", async () => {
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  const mk = (id: string, over: Record<string, unknown>) =>
    upsertOrder(SHOP, mapShopifyOrder(node({ id: `gid://shopify/Order/${id}`, legacyResourceId: id, name: `#${id}`, ...over })));
  await mk("1", {});
  await mk("2", {});
  await mk("3", { displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "DELIVERED" }] });
  await mk("4", { cancelledAt: "2026-11-02T00:00:00Z" });
  await mk("5", { tags: ["RTO"], displayFulfillmentStatus: "FULFILLED" });
  await mk("1", {}); // duplicate fetch
  let c = await statusCounts({ shop: SHOP });
  assert.deepEqual([c.total, c.Unfulfilled, c.Delivered, c.Cancelled, c.RTO, c.Fulfilled], [5, 2, 1, 1, 1, 0]);

  await mk("2", { updatedAt: "2026-11-05T00:00:00Z", cancelledAt: "2026-11-05T00:00:00Z" });
  c = await statusCounts({ shop: SHOP });
  assert.deepEqual([c.total, c.Unfulfilled, c.Cancelled], [5, 1, 2]);
});

test("google sheet: 27 columns in order, employee values win, safe parsing", async () => {
  const { SHEET_HEADERS, rowToValues, spreadsheetIdFrom, parseServiceAccount, dataRange } = await import("../app/lib/google-sheet-format.ts");
  assert.equal(SHEET_HEADERS.length, 27);
  assert.equal(SHEET_HEADERS[22], "Remarks");
  assert.equal(SHEET_HEADERS[23], "Employee Remark");
  const base = {
    callDate: null, employeeName: "Ravi", orderName: "#1001", orderDate: new Date("2026-11-01T10:00:00Z"), customerName: "Asha", productName: "HP Printer",
    qty: 2, amount: 2998, paymentType: "COD", primaryMobile: "+919822222222", altMobile: null, altMobileShopify: "+919811111111",
    fullAddress: "12 MG Road", landmark: "Near Metro", city: "Pune", state: "MH", pinCode: "411001", addressConfirmed: "Yes", codConfirmed: "Yes",
    deliveryAvailable: "Yes", customerWants: "Yes", callStatus: "Connected", finalDecision: "Confirmed", remarks: "Fulfilled · In transit",
    status: "Fulfilled", isManual: false, employeeRemark: "=HYPERLINK(\"evil\")", dispatchDate: null, dispatchDateShopify: new Date("2026-11-02T00:00:00Z"),
    awb: null, trackingNo: "AWB123", deliveryCharges: 40, shippingCharge: 60,
  };
  const v = rowToValues(base);
  assert.equal(v.length, 27);
  assert.equal(v[10], "+919811111111"); // alternate mobile falls back to Shopify's
  assert.equal(v[22], "Fulfilled · In transit");
  assert.equal(v[24], "2026-11-02");
  assert.equal(v[25], "AWB123");
  assert.equal(v[26], 40); // the employee's delivery charge beats Shopify's shipping line
  assert.equal(rowToValues({ ...base, altMobile: "9000000000" })[10], "9000000000");
  assert.equal(spreadsheetIdFrom("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0"), "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  assert.equal(spreadsheetIdFrom("nope"), null);
  assert.equal(parseServiceAccount("not json"), null);
  assert.equal(parseServiceAccount(JSON.stringify({ type: "authorized_user" })), null);
  assert.deepEqual(parseServiceAccount(JSON.stringify({ type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx" })), { email: "a@b.iam.gserviceaccount.com", privateKey: "-----BEGIN PRIVATE KEY-----\nx" });
  assert.equal(dataRange("Order Calling Sheet", 2, 5), "'Order Calling Sheet'!A2:AA5");
});
