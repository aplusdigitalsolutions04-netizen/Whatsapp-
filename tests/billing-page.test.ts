/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { closeApp, loadApp } from "./helpers/load-app.ts";

after(async () => { await closeApp(); });

test("billing page renders empty and with results", async () => {
  const { React, renderToString, createStaticHandler, createStaticRouter, StaticRouterProvider }: any = await loadApp("/tests/helpers/shim.ts");
  const mod: any = await loadApp("/app/routes/app.billing-data.tsx");
  const render = async (actionResult?: any) => {
    const handler = createStaticHandler([{ path: "/", Component: mod.default, action: () => actionResult ?? null }]);
    const req = actionResult ? new Request("http://localhost/", { method: "POST", body: new URLSearchParams({ ids: "#W1" }) }) : new Request("http://localhost/");
    const ctx: any = await handler.query(req);
    const router = createStaticRouter(handler.dataRoutes, ctx);
    return renderToString(React.createElement(StaticRouterProvider, { router, context: ctx }));
  };
  const html = await render();
  assert.ok(html.includes("Billing Data") && html.includes("Fetch billing data"));
  const rows = [{ orderId: "#W1", orderDate: "14 Nov 2026", customerName: "Asha", phone: "9876543210", email: "a@b.c", address: "x", hasGst: "No", gstNumber: "", companyName: "", itemName: "Printer", quantity: 1, price: "10.00", gstPercent: "18", gstAmount: "1.80", totalAmount: "11.80" }];
  const html2 = await render({ ok: true, text: "#W1", error: null, result: { rows, found: ["#W1"], missing: ["#W9"], invalid: [], skipped: [] } });
  assert.ok(html2.includes("Download CSV") && html2.includes("Printer") && html2.includes("Not found"), html2.slice(0, 500));
  const html3 = await render({ ok: false, text: "", error: "Type or paste at least one order id.", result: null });
  assert.ok(html3.includes("Type or paste"));
  console.log("rendered ok");
});
