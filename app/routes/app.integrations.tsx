/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { testShopifyConnection } from "../lib/shopify-data.server";
import { randomBytes } from "node:crypto";
import { whatsappConfig, whatsappDiagnostics } from "../lib/whatsapp.server";
import { CRED_NAMES, CRED_RULES, type CredName } from "../lib/cloud-cred-rules";
import { credStatus, removeCreds, saveCreds } from "../lib/cloud-creds.server";
import { Badge, Banner, Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const lastWebhook = await prisma.webhookEvent.findFirst({ orderBy: { createdAt: "desc" } });
  return {
    config: whatsappConfig(),
    creds: await credStatus(session.shop), // only "saved" and the last 4 characters, never a key
    webhookPath: "/api/webhooks/whatsapp",
    lastWebhookAt: lastWebhook?.createdAt.toISOString() ?? null,
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const target = String(form.get("target"));
  if (target === "save-keys") {
    const input: Partial<Record<CredName, string>> = {};
    for (const n of CRED_NAMES) input[n] = String(form.get(n) ?? "");
    const r = await saveCreds(session.shop, input);
    return { target, keys: r.ok ? { ok: true as const, saved: r.saved.map((n) => CRED_RULES[n].label) } : { ok: false as const, error: r.error } };
  }
  if (target === "generate-verify") {
    // The one value that has to be copied into Meta, so it is shown once right after it is made.
    const token = randomBytes(24).toString("hex");
    await saveCreds(session.shop, { verifyToken: token });
    return { target, generated: token };
  }
  if (target === "remove-keys") {
    await removeCreds(session.shop);
    return { target, removed: true };
  }
  if (target === "shopify") return { target, shopify: await testShopifyConnection(session.shop, true) };
  if (target === "whatsapp") return { target, whatsapp: await whatsappDiagnostics() };
  return {};
};

const Row = ({ label, ok }: { label: string; ok: boolean }) => (
  <li>{label}: <Badge tone={ok ? "success" : "critical"}>{ok ? "Set" : "Missing"}</Badge></li>
);

export default function Integrations() {
  const { config, creds, webhookPath, lastWebhookAt, appUrl } = useLoaderData<typeof loader>();
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
              <Banner tone="success">
                Orders and customer details can be read{result.shopify.orders?.readable != null ? ` (${result.shopify.orders.readable} orders visible to the app)` : ""}. The bot can look orders up.
              </Banner>
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
        <p className="o-p">Saved keys are encrypted in the database and never sent to the browser.</p>
      </Card>

      <Card title="Meta API keys (saved safely in this app)">
        <p className="o-p">
          Paste the keys from developers.facebook.com. They are encrypted before they are saved and are <b>never shown again</b>: this page only tells you
          that a key is saved and how it ends. Leave a field empty to keep the saved key.
        </p>
        <Form method="post" autoComplete="off">
          <input type="hidden" name="target" value="save-keys" />
          {CRED_NAMES.map((n) => (
            <p key={n}>
              <label>
                {CRED_RULES[n].label}{" "}
                {creds[n].saved ? <Badge tone="success">Saved {creds[n].hint}</Badge> : creds[n].fromEnv ? <Badge>From server settings</Badge> : <Badge tone="critical">Missing</Badge>}
                <br />
                <input type="password" name={n} autoComplete="new-password" spellCheck={false} placeholder={creds[n].saved ? "Saved. Type a new one only to replace it" : CRED_RULES[n].hint} style={{ width: "100%", maxWidth: 460 }} />
              </label>
            </p>
          ))}
          <button disabled={busy}>Save keys</button>{" "}
          <button type="submit" name="target" value="generate-verify" disabled={busy}>Make a verify token for me</button>{" "}
          <button type="submit" name="target" value="remove-keys" disabled={busy} onClick={(e) => { if (!confirm("Remove all saved Meta keys?")) e.preventDefault(); }}>Remove saved keys</button>
        </Form>
        {result?.keys?.ok && <Banner tone="success">Saved: {result.keys.saved.join(", ")}. Run diagnostics above to check them.</Banner>}
        {result?.keys && !result.keys.ok && <Banner tone="critical">{result.keys.error}</Banner>}
        {result?.removed && <Banner tone="success">The saved keys were removed.</Banner>}
        {result?.generated && (
          <Banner tone="success">
            Verify token (copy it into Meta now, it is not shown again): <code>{result.generated}</code>
          </Banner>
        )}
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
