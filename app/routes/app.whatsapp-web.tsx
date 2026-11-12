import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { activeProvider, bridgeStatus, startBridge, stopBridge } from "../lib/bridge.server";
import { logEvent } from "../lib/log.server";
import { Banner, Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { ...bridgeStatus(), provider: activeProvider() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const intent = String((await request.formData()).get("intent"));
  if (intent === "connect") await startBridge();
  if (intent === "disconnect") await stopBridge(false);
  if (intent === "logout") {
    await stopBridge(true);
    await logEvent({ shop: session.shop, source: "admin", event: "bridge_unlinked" });
  }
  return null;
};

export default function WhatsAppWeb() {
  const s = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  const { revalidate } = useRevalidator();

  // Poll while a QR code or connection is pending so the page updates on scan.
  useEffect(() => {
    if (s.state !== "starting" && s.state !== "qr") return;
    const t = setInterval(revalidate, 3000);
    return () => clearInterval(t);
  }, [s.state, revalidate]);

  return (
    <Page title="WhatsApp Web (QR)">
      {s.provider !== "qr" && (
        <Banner tone="warning">
          The official Cloud API is the active provider (WHATSAPP_PROVIDER=cloud or Cloud API credentials are set), so
          replies will NOT go through this QR connection. Set WHATSAPP_PROVIDER=qr to use it.
        </Banner>
      )}
      <Card title="Connection">
        {s.state === "connected" && (
          <Banner tone="success">
            Connected{s.number ? ` as +${s.number}` : ""}. The bot is replying through this number.
            <br />
            <small>
              Messages received since start: {s.received}. Last message event from WhatsApp:{" "}
              {s.lastUpsertAt ? new Date(s.lastUpsertAt).toLocaleTimeString() : "none yet"}.
            </small>
          </Banner>
        )}
        {s.state === "error" && <Banner tone="critical">{s.error}</Banner>}
        {s.state !== "error" && s.error && <Banner tone="warning">{s.error}</Banner>}
        {s.state === "starting" && <p className="o-p">Starting… a QR code will appear in a few seconds.</p>}
        {s.state === "stopped" && (
          <p className="o-p">{s.paired ? "Linked but not running." : "Not linked yet."} Click Connect to start.</p>
        )}
        {s.state === "qr" && s.qr && (
          <>
            <div className="o-qr"><img src={s.qr} alt="WhatsApp QR code" width={280} height={280} /></div>
            <p className="o-p">
              On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code. It refreshes
              automatically.
            </p>
          </>
        )}
        <div className="o-row" style={{ marginTop: 14 }}>
          {s.state !== "connected" && (
            <Form method="post"><button name="intent" value="connect" disabled={busy || s.state === "starting" || s.state === "qr"}>Connect</button></Form>
          )}
          {s.state === "connected" && (
            <Form method="post"><button className="ghost" name="intent" value="disconnect" disabled={busy}>Pause</button></Form>
          )}
          {(s.paired || s.state === "connected") && (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!window.confirm("Unlink this WhatsApp number? You'll need to scan a new QR code to reconnect.")) e.preventDefault();
              }}
            >
              <button className="danger" name="intent" value="logout" disabled={busy}>Unlink number</button>
            </Form>
          )}
        </div>
      </Card>
      <Card title="Good to know">
        <p className="o-p">
          This uses the unofficial WhatsApp Web protocol. It is not endorsed by WhatsApp, and automated replies can get a
          number restricted. Use a dedicated business number, not your personal one.
        </p>
        <p className="o-p">The server must stay running. The login is stored in the <code>.wa-auth</code> folder; keep it private.</p>
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
