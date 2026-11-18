import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { Form, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Download } from "lucide-react";
import { authenticate } from "../shopify.server";
import { BILLING_COLUMNS, MAX_BILLING_ORDERS, billingCsv, type BillingRow } from "../lib/billing-data";
import { fetchBillingOrders } from "../lib/billing-data.server";
import { explainShopifyError } from "../lib/shopify-errors";
import { Banner, Card, Page } from "../components/ui";

// Billing Data: type the order ids, get only those orders' billing details, download them as a CSV.
// Nothing is saved; the CSV is built in the browser from what was fetched.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const text = String(form.get("ids") ?? "").slice(0, 20_000);
  if (!text.trim()) return { ok: false as const, text, error: "Type or paste at least one order id.", result: null };
  try {
    return { ok: true as const, text, error: null, result: await fetchBillingOrders(session.shop, text) };
  } catch (e) {
    return { ok: false as const, text, error: explainShopifyError(String((e as Error).message ?? e)), result: null };
  }
};

function download(rows: BillingRow[]) {
  const blob = new Blob([billingCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `billing-data-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function BillingData() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [text, setText] = useState("");
  const r = data?.result ?? null;

  return (
    <Page title="Billing Data" subtitle="Type the order ids. Only those orders are fetched, and you can download them as a CSV sheet.">
      <Card>
        <Form method="post" className="o-field">
          <label htmlFor="ids">
            <b>Order IDs</b> <span className="o-muted">(one per line, or separated by commas or spaces, e.g. #W1219, #W1220)</span>
          </label>
          <textarea
            id="ids"
            name="ids"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"#W1219\n#W1220\n#W1221"}
            spellCheck={false}
            style={{ fontFamily: "monospace" }}
          />
          <div className="o-row" style={{ marginTop: 10 }}>
            <button type="submit" disabled={busy}>{busy ? "Fetching…" : "Fetch billing data"}</button>
            <span className="o-muted">Up to {MAX_BILLING_ORDERS} orders at a time.</span>
          </div>
        </Form>
      </Card>

      {data?.error && <Banner tone="critical">{data.error}</Banner>}

      {r && (
        <>
          {r.found.length > 0 && (
            <Banner tone="success">
              Found {r.found.length} order{r.found.length > 1 ? "s" : ""} ({r.rows.length} item row{r.rows.length > 1 ? "s" : ""}).
            </Banner>
          )}
          {r.missing.length > 0 && (
            <Banner tone="warning">
              Not found: <b>{r.missing.join(", ")}</b>. Check the order number. Orders older than 60 days can only be read when Shopify&apos;s <i>read_all_orders</i> permission is granted to this app.
            </Banner>
          )}
          {r.invalid.length > 0 && <Banner tone="warning">These are not order ids and were ignored: <b>{r.invalid.join(", ")}</b></Banner>}
          {r.skipped.length > 0 && <Banner tone="warning">Only the first {MAX_BILLING_ORDERS} orders are fetched at a time. Left out: {r.skipped.join(", ")}</Banner>}

          {r.rows.length > 0 && (
            <Card
              title="Billing data"
              action={
                <button type="button" onClick={() => download(r.rows)}>
                  <Download size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                  Download CSV
                </button>
              }
            >
              <div className="o-scroll">
                <table>
                  <thead>
                    <tr>{BILLING_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row, i) => (
                      <tr key={`${row.orderId}-${i}`}>
                        {BILLING_COLUMNS.map((c) => <td key={c.key}>{String(row[c.key] ?? "") || "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="o-muted" style={{ marginTop: 10 }}>
                One row per item. An order with 3 items gives 3 rows with the same order details. <b>Total Amount</b> is the whole order&apos;s total (items, tax and shipping) and repeats on each row of that order, so do not add that column up. <b>Has GST</b> is the customer&apos;s Yes / No answer; the GST number is fetched from the checkout&apos;s GST field, the order note or the company line of the address.
              </p>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
