import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { Badge, Card, Page } from "../components/ui";

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const filter = ["found", "missing"].includes(url.searchParams.get("filter") ?? "") ? url.searchParams.get("filter")! : "all";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where: Record<string, unknown> = { shop };
  if (filter === "found") where.found = true;
  if (filter === "missing") where.found = false;
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.OR = [{ query: { contains: q } }, { customerName: { contains: q } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])];
  }

  const [rows, total, all, missing, top, convs] = await Promise.all([
    prisma.productEnquiry.findMany({ where, orderBy: { createdAt: "desc" }, take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
    prisma.productEnquiry.count({ where }),
    prisma.productEnquiry.count({ where: { shop } }),
    prisma.productEnquiry.count({ where: { shop, found: false } }),
    prisma.productEnquiry.groupBy({ by: ["query"], where: { shop }, _count: { query: true }, orderBy: { _count: { query: "desc" } }, take: 6 }),
    prisma.conversation.findMany({ where: { shop }, select: { id: true, phone: true } }),
  ]);
  const convByPhone = new Map(convs.map((c) => [c.phone, c.id]));

  return {
    q, filter, page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), all, missing,
    top: top.map((t) => ({ query: t.query, count: t._count.query })),
    rows: rows.map((r) => ({
      id: r.id, phone: r.phone, name: r.customerName, query: r.query, found: r.found,
      products: (() => {
        try {
          return JSON.parse(r.products) as string[];
        } catch {
          return [];
        }
      })(),
      at: r.createdAt.toISOString(), convId: convByPhone.get(r.phone) ?? r.conversationId,
    })),
  };
};

const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function Enquiries() {
  const d = useLoaderData<typeof loader>();
  useAutoRefresh(15000);
  const link = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ q: d.q, filter: d.filter, page: String(d.page), ...patch });
    for (const [k, v] of [...p]) if (!v || (k === "filter" && v === "all") || (k === "page" && v === "1")) p.delete(k);
    return `?${p.toString()}`;
  };

  return (
    <Page title="Product Enquiries" subtitle="Which customer number asked about which product, and whether the bot had it.">
      <div className="d-kpis" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="d-kpi"><div className="d-kpi-label">Total enquiries</div><div className="d-kpi-value">{d.all}</div></div>
        <div className="d-kpi"><div className="d-kpi-label">Products we had</div><div className="d-kpi-value">{d.all - d.missing}</div></div>
        <div className="d-kpi"><div className="d-kpi-label">Not available</div><div className="d-kpi-value" style={d.missing ? { color: "var(--bad)" } : undefined}>{d.missing}</div></div>
      </div>

      {d.top.length > 0 && (
        <Card title="Most asked">
          <div className="o-row">
            {d.top.map((t) => (
              <Link key={t.query} to={link({ q: t.query, page: "1" })}><Badge>{t.query} · {t.count}</Badge></Link>
            ))}
          </div>
        </Card>
      )}

      <Card
        title={`Enquiries (${d.total})`}
        action={
          <div className="o-row">
            <Form method="get" className="o-row">
              <input name="q" defaultValue={d.q} placeholder="Search number, name or product" aria-label="Search enquiries" style={{ width: 240 }} />
              {d.filter !== "all" && <input type="hidden" name="filter" value={d.filter} />}
              <button className="ghost">Search</button>
            </Form>
            <div className="d-range" role="group" aria-label="Filter">
              {([["all", "All"], ["found", "Available"], ["missing", "Unavailable"]] as const).map(([k, label]) => (
                <Link key={k} to={link({ filter: k, page: "1" })} className={d.filter === k ? "on" : ""}>{label}</Link>
              ))}
            </div>
          </div>
        }
      >
        {d.rows.length === 0 ? (
          <p className="d-empty">No enquiries yet. They appear here when a customer asks the bot about a product.</p>
        ) : (
          <div className="o-scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Customer</th><th>Number</th><th>Asked for</th><th>Result</th></tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                    <td>{r.name ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.convId ? <Link to={`/app/conversations?c=${r.convId}`}>{r.phone}</Link> : r.phone}
                    </td>
                    <td><b>{r.query}</b></td>
                    <td>
                      {r.found ? (
                        <>
                          <Badge tone="success">Available</Badge>
                          <div style={{ marginTop: 4, color: "var(--ink-2)" }}>{r.products.slice(0, 3).join(" · ")}{r.products.length > 3 ? ` +${r.products.length - 3}` : ""}</div>
                        </>
                      ) : (
                        <Badge tone="critical">Unavailable</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.pages > 1 && (
          <div className="o-row" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <span className="o-muted">Page {d.page} of {d.pages}</span>
            <div className="o-row">
              {d.page > 1 && <Link to={link({ page: String(d.page - 1) })}>← Newer</Link>}
              {d.page < d.pages && <Link to={link({ page: String(d.page + 1) })}>Older →</Link>}
            </div>
          </div>
        )}
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
