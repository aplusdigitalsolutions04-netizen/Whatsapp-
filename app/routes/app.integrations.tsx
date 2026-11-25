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
import { enqueueAllOrders, enqueueOneOrder, imsStatus, retryFailedImsPushes, saveImsConfig } from "../lib/ims-push.server";
import { useAutoRefresh } from "../components/useAutoRefresh";
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
    ims: await imsStatus(session.shop), // IMS portal: address, whether a key is saved (never the key), and what was sent / is waiting / failed
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
  if (target === "ims-save") {
    const r = await saveImsConfig(session.shop, { url: String(form.get("imsUrl") ?? ""), key: String(form.get("imsKey") ?? ""), enabled: form.get("imsEnabled") === "on" });
    return { target, ims: r.ok ? { ok: true as const, message: "IMS settings saved." } : { ok: false as const, message: r.error } };
  }
  if (target === "ims-one") {
    const r = await enqueueOneOrder(session.shop, String(form.get("orderNo") ?? ""));
    return { target, ims: r.ok ? { ok: true as const, message: `Order ${r.name} is on its way to the IMS (a few seconds).` } : { ok: false as const, message: r.error } };
  }
  if (target === "ims-all") {
    const n = await enqueueAllOrders(session.shop);
    return { target, ims: { ok: true as const, message: `${n.toLocaleString()} orders are queued. They go to the IMS 10 at a time; you can watch the numbers below.` } };
  }
  if (target === "ims-retry") {
    const n = await retryFailedImsPushes(session.shop);
    return { target, ims: { ok: true as const, message: `${n} failed order${n === 1 ? "" : "s"} queued again.` } };
  }
  if (target === "shopify") return { target, shopify: await testShopifyConnection(session.shop, true) };
  if (target === "whatsapp") return { target, whatsapp: await whatsappDiagnostics() };
  return {};
};

const Row = ({ label, ok }: { label: string; ok: boolean }) => (
  <li>{label}: <Badge tone={ok ? "success" : "critical"}>{ok ? "Set" : "Missing"}</Badge></li>
);

export default function Integrations() {
  const { config, creds, webhookPath, lastWebhookAt, appUrl, ims } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as any;
  const busy = useNavigation().state !== "idle";
  useAutoRefresh(ims.pending > 0 && ims.cfg.enabled ? 3000 : 30000); // the numbers move while orders are being sent

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

      <Card title="IMS portal (send orders to your IMS)">
        <p className="o-muted">
          Every new WERY order goes to your IMS at once, and every change (status, tracking, cancel) follows after a few seconds. If the IMS is down or the key is wrong,
          nothing is lost: each order is tried again later, and the ones that cannot be sent are listed below with the reason.
        </p>
        <Form method="post">
          <input type="hidden" name="target" value="ims-save" />
          <p><label><input type="checkbox" name="imsEnabled" defaultChecked={ims.cfg.enabled} /> Send orders to the IMS</label></p>
          <label className="o-field">
            <span>IMS address (the full link the IMS team gave you)</span>
            <input name="imsUrl" defaultValue={ims.cfg.url} placeholder="https://your-ims.com/api/external/v1/shopify/orders" style={{ width: "100%" }} autoComplete="off" />
          </label>
          <label className="o-field">
            <span>IMS API key {ims.cfg.hasKey ? <Badge tone="success">Saved (ends …{ims.cfg.keyHint})</Badge> : <Badge tone="warning">Not saved</Badge>}</span>
            <input name="imsKey" type="password" placeholder={ims.cfg.hasKey ? "Leave empty to keep the saved key" : "Paste the key from the IMS team"} style={{ width: "100%" }} autoComplete="off" />
          </label>
          <button disabled={busy}>Save</button>
        </Form>
        {result?.ims && String(result.target ?? "").startsWith("ims") && <Banner tone={result.ims.ok ? "success" : "critical"}>{result.ims.message}</Banner>}
        {ims.cfg.lastError && <Banner tone="critical">Last problem: {ims.cfg.lastError}</Banner>}

        <div className="o-row" style={{ gap: 18, margin: "14px 0 6px", flexWrap: "wrap" }}>
          <span><b>{ims.sent.toLocaleString()}</b> sent</span>
          <span><b>{ims.pending.toLocaleString()}</b> waiting</span>
          <span style={ims.failed ? { color: "#a3261b" } : undefined}><b>{ims.failed.toLocaleString()}</b> failed</span>
          <span className="o-muted">{ims.lastSentAt ? `Last sent ${new Date(ims.lastSentAt).toLocaleString()}` : "Nothing sent yet"}</span>
        </div>

        <div className="o-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <Form method="post" className="o-row">
            <input type="hidden" name="target" value="ims-one" />
            <input name="orderNo" placeholder="Order, e.g. #W1219" aria-label="Order to send" style={{ width: 160 }} />
            <button className="ghost" disabled={busy || !ims.cfg.enabled}>Send this order now</button>
          </Form>
          <Form method="post" onSubmit={(e) => { if (!window.confirm("Send ALL old orders to the IMS? They go 10 at a time. An order the IMS already has is updated, not duplicated.")) e.preventDefault(); }}>
            <input type="hidden" name="target" value="ims-all" />
            <button className="ghost" disabled={busy || !ims.cfg.enabled}>Send old orders</button>
          </Form>
          {ims.failed > 0 && (
            <Form method="post">
              <input type="hidden" name="target" value="ims-retry" />
              <button disabled={busy}>Retry failed</button>
            </Form>
          )}
        </div>
        {!ims.cfg.enabled && <p className="o-muted" style={{ marginTop: 8 }}>Switch it on and save to start sending. Tip: first press <b>Send this order now</b> with one real order and ask the IMS team to confirm they got it, then press <b>Send old orders</b>.</p>}

        {ims.failedList.length > 0 && (
          <div className="o-scroll" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Order</th><th>Why it was not sent</th><th>Tries</th></tr></thead>
              <tbody>
                {ims.failedList.map((f) => (
                  <tr key={f.name}><td>{f.name}</td><td>{f.error}</td><td>{f.attempts}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
