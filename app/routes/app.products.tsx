import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listProducts } from "../lib/shopify-data.server";
import { Banner, Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 60);
  const after = url.searchParams.get("after");
  try {
    const { products, pageInfo } = await listProducts(session.shop, { after, search: q });
    return { q, products, pageInfo, error: null as string | null };
  } catch (e) {
    return { q, products: [], pageInfo: { hasNextPage: false, endCursor: null }, error: (e as Error).message };
  }
};

export default function Products() {
  const { products, pageInfo, q, error } = useLoaderData<typeof loader>();
  return (
    <Page title="Products">
      <Card>
        <Form method="get" className="o-row" style={{ marginBottom: 14 }}>
          <input name="q" defaultValue={q} placeholder="Name, SKU or keyword" aria-label="Search products" />
          <button type="submit">Search</button>
        </Form>
        <p className="o-p">The bot only recommends products that are Active, published to the storefront and in stock.</p>
        {error && <Banner tone="critical">Could not load products from Shopify: {error}</Banner>}
        {!error && products.length === 0 && <p className="o-p">No products found.</p>}
        {products.length > 0 && (
          <div className="o-scroll"><table>
            <thead>
              <tr>
                <th>Title</th><th>SKU</th><th>Price</th><th>Status</th><th>Stock</th><th>Bot-visible</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a> : p.title}</td>
                  <td>{p.skus.join(", ") || "—"}</td>
                  <td>{p.price ?? "—"}</td>
                  <td>{p.status}</td>
                  <td>{p.available ? "In stock" : "Out of stock"}</td>
                  <td>{p.status === "ACTIVE" && p.url && p.available ? "Yes" : "No"}</td>
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
