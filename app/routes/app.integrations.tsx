/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { testShopifyConnection } from "../lib/shopify-data.server";
import { whatsappConfig, whatsappDiagnostics } from "../lib/whatsapp.server";
import { Badge, Banner, Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const lastWebhook = await prisma.webhookEvent.findFirst({ orderBy: { createdAt: "desc" } });
  return {
    config: whatsappConfig(),
    webhookPath: "/api/webhooks/whatsapp",
    lastWebhookAt: lastWebhook?.createdAt.toISOString() ?? null,
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const target = String((await request.formData()).get("target"));
  if (target === "shopify") return { target, shopify: await testShopifyConnection(session.shop) };
  if (target === "whatsapp") return { target, whatsapp: await whatsappDiagnostics() };
  return {};
};

const Row = ({ label, ok }: { label: string; ok: boolean }) => (
  <li>{label}: <Badge tone={ok ? "success" : "critical"}>{ok ? "Set" : "Missing"}</Badge></li>
);

export default function Integrations() {
  const { config, webhookPath, lastWebhookAt, appUrl } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as any;
  const busy = useNavigation().state !== "idle";

  return (
    <Page title="Integrations">
      <Card title="Shopify">
        <Form method="post">
          <input type="hidden" name="target" value="shopify" />
          <button disabled={busy}>Test connection</button>
        </Form>
        {result?.shopify &&
          (result.shopify.ok ? (
            <>
              <Banner tone="success">Connected to {result.shopify.shopName} ({result.shopify.domain})</Banner>
              <ul>
                {result.shopify.scopes.map((s: any) => (
                  <li key={s.scope}>{s.scope}: <Badge tone={s.granted ? "success" : "critical"}>{s.granted ? "Granted" : "Missing"}</Badge></li>
                ))}
              </ul>
              <p className="o-p">Order and customer data also requires approved Protected Customer Data access in the Partner Dashboard.</p>
            </>
          ) : (
            <Banner tone="critical">Failed: {result.shopify.error}</Banner>
          ))}
      </Card>

      <Card title="WhatsApp Business Cloud API">
        <ul>
          <Row label="WHATSAPP_ACCESS_TOKEN" ok={config.accessToken} />
          <Row label="WHATSAPP_PHONE_NUMBER_ID" ok={config.phoneNumberId} />
          <Row label="WHATSAPP_VERIFY_TOKEN" ok={config.verifyToken} />
          <Row label="WHATSAPP_APP_SECRET" ok={config.appSecret} />
        </ul>
        <p className="o-p">
          Webhook callback URL: <code>{appUrl}{webhookPath}</code>. Last event received:{" "}
          {lastWebhookAt ? new Date(lastWebhookAt).toLocaleString() : "none yet"}.
        </p>
        <Form method="post">
          <input type="hidden" name="target" value="whatsapp" />
          <button disabled={busy}>Run diagnostics</button>
        </Form>
        {result?.whatsapp &&
          (result.whatsapp.ok ? (
            <Banner tone="success">
              Connected: {result.whatsapp.verifiedName} ({result.whatsapp.displayNumber})
              {result.whatsapp.quality ? ` · quality ${result.whatsapp.quality}` : ""}
            </Banner>
          ) : (
            <Banner tone="critical">Failed: {result.whatsapp.error}</Banner>
          ))}
        <p className="o-p">Secrets are read from server environment variables and never sent to the browser.</p>
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
