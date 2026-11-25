/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { closeApp, loadApp } from "./helpers/load-app.ts";

const SHOP = "integrations-page-test.invalid"; // isolated shop; its rows are removed afterwards
after(async () => {
  await prisma.imsPush.deleteMany({ where: { shop: SHOP } });
  await prisma.imsConfig.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  await closeApp();
});

test("Integrations page: the old cards are still there and the IMS card shows address, saved key, counts and failed orders", async () => {
  const s: any = await loadApp("/app/lib/ims-push.server.ts");
  const { credStatus }: any = await loadApp("/app/lib/cloud-creds.server.ts");
  await s.saveImsConfig(SHOP, { url: "https://ims.example.com/api/external/v1/shopify/orders", key: "page-test-key-4321", enabled: true });
  await prisma.imsPush.create({ data: { shop: SHOP, orderGid: "gid://shopify/Order/1", orderName: "#W1", status: "sent", sentAt: new Date() } });
  await prisma.imsPush.create({ data: { shop: SHOP, orderGid: "gid://shopify/Order/2", orderName: "#W2", status: "failed", attempts: 10, lastError: "The IMS answered HTTP 401 (the API key was not accepted)" } });

  const { React, renderToString, createStaticHandler, createStaticRouter, StaticRouterProvider }: any = await loadApp("/tests/helpers/shim.ts");
  const mod: any = await loadApp("/app/routes/app.integrations.tsx");
  const handler = createStaticHandler([{
    path: "/", Component: mod.default,
    loader: async () => ({ config: { accessToken: false, phoneNumberId: false, verifyToken: false, appSecret: false }, creds: await credStatus(SHOP), webhookPath: "/api/webhooks/whatsapp", lastWebhookAt: null, appUrl: "https://app.example.com", ims: await s.imsStatus(SHOP) }),
  }]);
  const ctx: any = await handler.query(new Request("http://localhost/"));
  const html: string = renderToString(React.createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, ctx), context: ctx }));

  for (const t of ["Shopify", "WhatsApp Business Cloud API", "IMS portal (send orders to your IMS)"]) assert.ok(html.includes(t), t);
  assert.ok(html.includes("https://ims.example.com/api/external/v1/shopify/orders"), "the saved address is shown");
  assert.ok(html.replace(/<!-- -->/g, "").includes("ends …4321") && !html.includes("page-test-key"), "only the last 4 characters of the key, never the key");
  assert.ok(html.includes("Send old orders") && html.includes("Send this order now") && html.includes("Retry failed"));
  assert.ok(html.includes("#W2") && html.includes("API key was not accepted"), "a failed order is listed with the reason");
});
