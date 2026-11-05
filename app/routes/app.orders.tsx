import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listOrders } from "../lib/shopify-data.server";
import { Banner, Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 60);
  const after = url.searchParams.get("after");
  try {
    const { orders, pageInfo } = await listOrders(session.shop, { after, search: q });
    return { q, orders, pageInfo, error: null as string | null };
  } catch (e) {
    return { q, orders: [], pageInfo: { hasNextPage: false, endCursor: null }, error: (e as Error).message };
  }
};

export default function Orders() {
  const { orders, pageInfo, q, error } = useLoaderData<typeof loader>();
  return (
    <Page title="Orders">
      <Card>
        <Form method="get" className="o-row" style={{ marginBottom: 14 }}>
          <input name="q" defaultValue={q} placeholder="Order number or phone" aria-label="Search orders" />
          <button type="submit">Search</button>
        </Form>
        {error && <Banner tone="critical">Could not load orders from Shopify: {error}</Banner>}
        {!error && orders.length === 0 && <p className="o-p">No orders found.</p>}
        {orders.length > 0 && (
          <div className="o-scroll"><table>
            <thead>
              <tr>
                <th>Order</th><th>Date</th><th>Payment</th><th>Fulfilment</th><th>Total</th><th>Tracking</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.name}</td>
                  <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                  <td>{o.financialStatus}</td>
                  <td>{o.cancelled ? "CANCELLED" : o.fulfillmentStatus}</td>
                  <td>{o.total}</td>
                  <td>
                    {o.tracking.length === 0
                      ? "—"
                      : o.tracking.map((t, i) => (
                          <div key={i}>
                            {t.company} {t.resolvedUrl ? <a href={t.resolvedUrl} target="_blank" rel="noreferrer">{t.number ?? "link"}</a> : t.number}
                          </div>
                        ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {pageInfo.hasNextPage && (
          <p><Link to={`?q=${encodeURIComponent(q)}&after=${encodeURIComponent(pageInfo.endCursor ?? "")}`}>Next page →</Link></p>
        )}
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
