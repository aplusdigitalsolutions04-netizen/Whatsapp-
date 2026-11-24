import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { appsScriptCode, PROFIT_COLOR, rowToValues, SHEET_HEADERS } from "../app/lib/google-sheet-format.ts";
import { loadOrderSheet } from "../app/lib/order-sheet-data.server.ts";
import { profitLoss, profitTone } from "../app/lib/profit.ts";

const SHOP = "profit-test.invalid"; // isolated shop; its rows are removed afterwards
after(async () => {
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
});

test("profit / loss: amount - landing price - delivery charges", () => {
  assert.equal(profitLoss({ status: "Delivered", amount: 2998, landingPrice: 2000, deliveryCharges: 40 }), 958);
  assert.equal(profitLoss({ status: "Fulfilled", amount: 1000, landingPrice: 900, deliveryCharges: 150 }), -50, "a loss is negative");
  assert.equal(profitLoss({ status: "Unfulfilled", amount: 1000, landingPrice: 900, deliveryCharges: null }), 100, "no delivery charge yet counts as 0");
  assert.equal(profitLoss({ status: "Delivered", amount: 999.99, landingPrice: 500.5, deliveryCharges: 40.25 }), 459.24, "rounded to paise");
  assert.equal(profitLoss({ status: "Delivered", amount: 500, landingPrice: 500, deliveryCharges: 0 }), 0);
});

test("profit / loss: an RTO order is a loss of the delivery charges only", () => {
  assert.equal(profitLoss({ status: "RTO", amount: 2998, landingPrice: 2000, deliveryCharges: 80 }), -80);
  assert.equal(profitLoss({ status: "RTO", amount: 2998, landingPrice: null, deliveryCharges: 80 }), -80, "no landing price needed for an RTO");
  assert.equal(profitLoss({ status: "RTO", amount: 2998, landingPrice: 2000, deliveryCharges: null }), null, "delivery charge unknown: nothing to show");
  assert.equal(profitLoss({ status: "RTO", amount: 0, landingPrice: 0, deliveryCharges: 0 }), 0, "never -0");
});

test("profit / loss: empty when it cannot be known (cancelled, or the landing price is not filled in)", () => {
  assert.equal(profitLoss({ status: "Cancelled", amount: 1000, landingPrice: 500, deliveryCharges: 50 }), null);
  assert.equal(profitLoss({ status: "Delivered", amount: 1000, landingPrice: null, deliveryCharges: 50 }), null, "no landing price: never a made-up profit");
  assert.equal(profitLoss({ status: "Delivered", amount: null, landingPrice: 500, deliveryCharges: 50 }), null);
  assert.equal(profitLoss({ status: "Delivered", amount: 1000, landingPrice: undefined, deliveryCharges: undefined }), null);
});

test("profit tone: green above zero, red below, nothing at zero or unknown", () => {
  assert.equal(profitTone(958), "profit");
  assert.equal(profitTone(-80), "loss");
  assert.equal(profitTone(0), "");
  assert.equal(profitTone(null), "");
});

test("Order Update page data: Landing Price and Profit / Loss per order; Shopify's shipping line is the delivery charge until a person types one", async () => {
  let n = 0;
  const order = (over: Record<string, unknown>) =>
    prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: `pl${++n}`, orderName: `#PL${n}`, orderDate: new Date(), ...over } });
  await order({ status: "Delivered", amount: 3000, landingPrice: 2000, deliveryCharges: 100 }); // +900
  await order({ status: "Delivered", amount: 3000, landingPrice: 2000, shippingCharge: 60 }); // shipping line used: +940
  await order({ status: "RTO", amount: 3000, landingPrice: 2000, deliveryCharges: 100 }); // -100
  await order({ status: "Cancelled", amount: 3000, landingPrice: 2000, deliveryCharges: 100 }); // empty
  await order({ status: "Delivered", amount: 3000, deliveryCharges: 100 }); // no landing price: empty
  const { rows } = await loadOrderSheet(SHOP, new URL("http://localhost/app/order-sheet"));
  const by = (name: string) => rows.find((r) => r.v.orderName === name)!.v;
  assert.equal(by("#PL1").profitLoss, 900);
  assert.equal(by("#PL1").landingPrice, 2000);
  assert.equal(by("#PL2").profitLoss, 940);
  assert.equal(by("#PL3").profitLoss, -100);
  assert.equal(by("#PL4").profitLoss, null);
  assert.equal(by("#PL5").profitLoss, null);
});

test("Google Sheet: Landing Price and Profit / Loss are columns 28 and 29, and the Profit / Loss cell is coloured green / red", () => {
  assert.deepEqual(SHEET_HEADERS.slice(26), ["Delivery Charges", "Landing Price", "Profit / Loss", "Unit Price", "Item No."]);
  const base = {
    callDate: null, employeeName: null, orderName: "#1", orderDate: null, customerName: null, productName: null, qty: 1, amount: 3000, paymentType: null,
    primaryMobile: null, altMobile: null, altMobileShopify: null, fullAddress: null, landmark: null, city: null, state: null, pinCode: null,
    addressConfirmed: null, codConfirmed: null, deliveryAvailable: null, customerWants: null, callStatus: null, finalDecision: null,
    remarks: null, status: "Delivered", isManual: false, employeeRemark: null, dispatchDate: null, dispatchDateShopify: null, awb: null, trackingNo: null,
    deliveryCharges: 100, shippingCharge: null, landingPrice: 2000,
  };
  const v = rowToValues(base);
  assert.deepEqual([v[26], v[27], v[28]], [100, 2000, 900]);
  assert.deepEqual(rowToValues({ ...base, status: "RTO" }).slice(27, 29), [2000, -100]);
  assert.deepEqual(rowToValues({ ...base, landingPrice: null }).slice(27, 29), ["", ""], "nothing typed, nothing shown");
  assert.equal(rowToValues({ ...base, status: "Cancelled" })[28], "");

  const script = appsScriptCode("tok");
  assert.doesNotThrow(() => new Function(script), "the pasted script is valid JavaScript");
  assert.ok(script.includes("$AC5>0") && script.includes("$AC5<0"), "green above zero, red below zero, on column AC");
  assert.ok(script.includes(PROFIT_COLOR.profit) && script.includes(PROFIT_COLOR.loss));
  assert.ok(script.indexOf("[profit, loss].concat(rules)") > 0, "the profit rules come before the row colours, so they win");
});

test("item rows: one sheet row per item; order-level cells on the first row only; counters count an order once", async () => {
  const { orderItems, parseItems } = await import("../app/lib/order-map.ts");
  const { rowToValues, sheetRows, sheetRowCount, ITEM_NO_COL, counterFormulas } = await import("../app/lib/google-sheet-format.ts");
  const node = {
    lineItems: { nodes: [
      { title: "HP LaserJet 1008w", variantTitle: "Default Title", quantity: 1, currentQuantity: 1, sku: "HP1", discountedUnitPriceSet: { shopMoney: { amount: "10999.00" } } },
      { title: "USB Cable", variantTitle: "2 m", quantity: 2, currentQuantity: 2, sku: null, discountedUnitPriceSet: { shopMoney: { amount: "199.5" } } },
      { title: "Removed item", variantTitle: null, quantity: 1, currentQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: "50" } } },
    ] },
  };
  const items = orderItems(node);
  assert.deepEqual(items, [
    { name: "HP LaserJet 1008w", quantity: 1, unitPrice: 10999, sku: "HP1" },
    { name: "USB Cable (2 m)", quantity: 2, unitPrice: 199.5, sku: null },
  ], "a removed item is left out; Default Title is not part of the name");
  assert.deepEqual(parseItems(JSON.stringify(items)), items);
  assert.deepEqual(parseItems(null), []);
  assert.deepEqual(parseItems("not json"), []);

  const base = {
    callDate: null, employeeName: "Ravi", orderName: "#W1", orderDate: null, customerName: "Asha", productName: "joined", qty: 3, amount: 11398, paymentType: "COD",
    primaryMobile: "+919800000000", altMobile: null, altMobileShopify: null, fullAddress: "x", landmark: null, city: "Pune", state: null, pinCode: null,
    addressConfirmed: null, codConfirmed: null, deliveryAvailable: null, customerWants: null, callStatus: null, finalDecision: null,
    remarks: "Delivered", status: "Delivered", isManual: false, employeeRemark: null, dispatchDate: null, dispatchDateShopify: null, awb: null, trackingNo: null,
    deliveryCharges: 100, shippingCharge: null, landingPrice: 9000, items: JSON.stringify(items),
  };
  assert.equal(sheetRowCount(base), 2);
  const [a, b] = sheetRows(base);
  assert.equal(a.length, 31);
  assert.deepEqual([a[2], a[5], a[6], a[29], a[30]], ["#W1", "HP LaserJet 1008w", 1, 10999, 1], "first item: order id, item name, qty, unit price, item no. 1");
  assert.deepEqual([b[2], b[5], b[6], b[29], b[30]], ["#W1", "USB Cable (2 m)", 2, 199.5, 2], "second item row repeats the order id");
  assert.equal(a[7], 11398, "the order amount is on the first row");
  assert.equal(b[7], "", "...and not repeated (a sum of the column is right)");
  assert.deepEqual([a[26], a[27], a[28]], [100, 9000, 2298], "delivery, landing price and profit on the first row");
  assert.deepEqual([b[26], b[27], b[28]], ["", "", ""], "...not on the second");
  assert.equal(b[22], "Delivered", "the status is on every item row, so the colour follows it");
  assert.deepEqual([b[0], b[1], b[9], b[11]], ["", "", "", ""], "call details are not repeated");
  assert.equal(ITEM_NO_COL, "AE");
  assert.ok(counterFormulas().every((f) => f.includes("AE5:AE,1")), "every counter looks only at Item No. 1");

  // an order without stored items (hand-added row) is one row from the joined name and qty
  const manual = { ...base, items: null, isManual: true, status: "Unfulfilled", productName: "Printer", qty: 2 };
  assert.equal(sheetRowCount(manual), 1);
  const m = rowToValues(manual);
  assert.deepEqual([m[5], m[6], m[29], m[30]], ["Printer", 2, "", 1]);
});

test("Order Update page data: each order carries its items, a Shopify order without them still has one row", async () => {
  const { loadOrderSheet } = await import("../app/lib/order-sheet-data.server.ts");
  await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: "it1", orderName: "#IT1", orderDate: new Date(), status: "Delivered", amount: 500, items: JSON.stringify([{ name: "A", quantity: 1, unitPrice: 100, sku: null }, { name: "B", quantity: 2, unitPrice: 200, sku: null }]) } });
  await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: "it2", orderName: "#IT2", orderDate: new Date(), status: "Delivered", amount: 500, productName: "Joined", qty: 3 } });
  const { rows } = await loadOrderSheet(SHOP, new URL("http://localhost/app/order-sheet"));
  const one = rows.find((r) => r.v.orderName === "#IT1")!;
  assert.deepEqual(one.items.map((i) => [i.name, i.quantity, i.unitPrice]), [["A", 1, 100], ["B", 2, 200]]);
  assert.equal(rows.find((r) => r.v.orderName === "#IT2")!.items.length, 0, "no stored items: the page shows one row from the joined name");
});
