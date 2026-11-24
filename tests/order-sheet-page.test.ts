/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { closeApp, loadApp } from "./helpers/load-app.ts";

const SHOP = "sheet-page-test.invalid"; // isolated shop; its rows are removed afterwards
after(async () => {
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  await closeApp();
});

test("Order Update page: one row per item, order-level cells on the first row only, Fulfilled column adds up, profit cell coloured", async () => {
  const now = new Date();
  const items = JSON.stringify([{ name: "HP LaserJet 1008w", quantity: 1, unitPrice: 10999, sku: null }, { name: "USB Cable (2 m)", quantity: 2, unitPrice: 199.5, sku: null }]);
  await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: "pg1", orderName: "#PG1", orderDate: now, status: "Fulfilled", remarks: "Fulfilled", amount: 11398, landingPrice: 9000, deliveryCharges: 100, items } });
  await prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: "pg2", orderName: "#PG2", orderDate: now, status: "RTO", remarks: "RTO", amount: 2000, landingPrice: 1500, deliveryCharges: 80, items: JSON.stringify([{ name: "Mouse", quantity: 1, unitPrice: 2000, sku: null }]) } });

  const { React, renderToString, createStaticHandler, createStaticRouter, StaticRouterProvider }: any = await loadApp("/tests/helpers/shim.ts");
  const mod: any = await loadApp("/app/routes/app.order-sheet.tsx");
  const { loadOrderSheet }: any = await loadApp("/app/lib/order-sheet-data.server.ts");
  const handler = createStaticHandler([{ path: "/", Component: mod.default, loader: async () => ({ ...(await loadOrderSheet(SHOP, new URL("http://localhost/app/order-sheet"))), script: "", tasks: [] }) }]);
  const ctx: any = await handler.query(new Request("http://localhost/"));
  const html: string = renderToString(React.createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, ctx), context: ctx }));

  for (const h of ["Item Name", "Unit Price", "Landing Price", "Profit / Loss", "Order ID"]) assert.ok(html.includes(`>${h}<`), h);
  assert.ok(html.includes("HP LaserJet 1008w") && html.includes("USB Cable (2 m)") && html.includes("Mouse"), "every item has its own row");
  const trs = html.match(/<tr class="os-row/g) ?? [];
  assert.equal(trs.length, 3, "2 items + 1 item = 3 table rows");
  assert.equal((html.match(/os-row st-Fulfilled os-sub/g) ?? []).length, 1, "the second item of #PG1 is a sub row");
  assert.ok(html.includes("pl-profit") && html.includes("pl-loss"), "profit cell green, RTO loss cell red");
  assert.ok(html.includes(">+2,298<") && html.includes(">-80<"), "signed profit / loss: 11398-9000-100 and the RTO delivery charge");
  assert.ok(html.includes("c-Fulfilled"), "the counters table has a Fulfilled column");
});
