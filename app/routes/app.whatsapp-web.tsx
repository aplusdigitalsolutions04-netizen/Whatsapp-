import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { activeProvider, bridgeStatus, startBridge, stopBridge } from "../lib/bridge.server";
import prisma from "../db.server";
import { historyRow, summarizeHistory, type HistoryRow } from "../lib/bridge-reasons";
import { logEvent } from "../lib/log.server";
import { Banner, Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const rows = await prisma.activityLog.findMany({
    where: { source: "whatsapp", event: { in: ["bridge_connected", "bridge_closed", "bridge_replaced", "bridge_logged_out", "bridge_app_started"] } },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  const history = rows.map(historyRow).filter((r): r is HistoryRow => !!r);
  return { ...bridgeStatus(), provider: activeProvider(), history, summary: summarizeHistory(history) };
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
    if (s.state === "connected") return;
    const t = setInterval(revalidate, s.state === "starting" || s.state === "qr" ? 3000 : 6000);
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
      <Card title="Why does it disconnect?">
        <p className="o-p"><b>{s.summary.verdict}</b></p>
        {s.lastClose && (
          <p className="o-p">
            Last disconnect, {new Date(s.lastClose.at).toLocaleString()}: <b>{s.lastClose.title}</b>
            {s.lastClose.code ? ` (code ${s.lastClose.code})` : ""}. {s.lastClose.advice}
          </p>
        )}
        <p className="o-muted">
          In the last 24 hours: {s.summary.disconnects} disconnect{s.summary.disconnects === 1 ? "" : "s"}, {s.summary.restarts} app restart{s.summary.restarts === 1 ? "" : "s"}.
          This copy of the app has been running for {s.uptimeSec >= 3600 ? `${Math.floor(s.uptimeSec / 3600)} h ${Math.floor((s.uptimeSec % 3600) / 60)} min` : `${Math.floor(s.uptimeSec / 60)} min`}.
        </p>
        {s.history.length > 0 && (
          <div className="o-scroll">
            <table>
              <thead><tr><th>When</th><th>What happened</th><th>What it means</th></tr></thead>
              <tbody>
                {s.history.map((h, i) => (
                  <tr key={i}>
                    <td>{new Date(h.at).toLocaleString()}</td>
                    <td><b>{h.title}</b></td>
                    <td>{h.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
