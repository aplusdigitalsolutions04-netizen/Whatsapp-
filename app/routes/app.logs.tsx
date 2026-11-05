import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { rateLimited } from "../lib/rate-limit.server";
import { processEvent } from "../lib/webhook-processor.server";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [events, logs] = await Promise.all([
    prisma.webhookEvent.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return {
    events: events.map((e) => ({
      id: e.id, type: e.type, status: e.status, attempts: e.attempts, error: e.error,
      duplicates: e.duplicates, at: e.createdAt.toISOString(),
    })),
    logs: logs.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (rateLimited(`retry:${session.shop}`, 20, 60_000)) return { ok: false, message: "Too many retries." };
  const id = String((await request.formData()).get("id"));
  const ev = await prisma.webhookEvent.findUnique({ where: { id } });
  if (!ev || ev.status !== "failed") return { ok: false, message: "Only failed events can be retried." };
  // Safe: bot replies are keyed by the inbound message id, so a retry cannot double-send.
  await processEvent(id);
  const after = await prisma.webhookEvent.findUnique({ where: { id } });
  return after?.status === "processed"
    ? { ok: true, message: "Event processed." }
    : { ok: false, message: `Retry failed: ${after?.error ?? "unknown error"}` };
};

export default function Logs() {
  const { events, logs } = useLoaderData<typeof loader>();
  useAutoRefresh(8000);
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const shopify = useAppBridge();

  useEffect(() => {
    if (result?.message) shopify.toast.show(result.message, { isError: !result.ok });
  }, [result, shopify]);

  return (
    <Page title="Logs">
      <Card title="Webhook events">
        {events.length === 0 ? (
          <p className="o-p">No webhook events received yet.</p>
        ) : (
          <div className="o-scroll"><table>
            <thead>
              <tr><th>Time</th><th>Type</th><th>Status</th><th>Attempts</th><th>Duplicates</th><th>Error</th><th /></tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.at).toLocaleString()}</td>
                  <td>{e.type}</td>
                  <td>{e.status}</td>
                  <td>{e.attempts}</td>
                  <td>{e.duplicates}</td>
                  <td className="o-muted">{e.error}</td>
                  <td>
                    {e.status === "failed" && (
                      <Form method="post"><input type="hidden" name="id" value={e.id} /><button className="ghost" disabled={busy}>Retry</button></Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <Card title="Activity and errors">
        {logs.length === 0 ? (
          <p className="o-p">No log entries yet.</p>
        ) : (
          <ul className="o-list">
            {logs.map((l) => (
              <li key={l.id} className={l.level === "error" ? "err" : ""}>
                {new Date(l.createdAt).toLocaleString()} · {l.source}/{l.event}{l.detail ? ` — ${l.detail}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
