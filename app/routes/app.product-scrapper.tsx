import { rmSync } from "node:fs";
import path from "node:path";
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Download, Search, Square, Trash2 } from "lucide-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { signedFinderUrl } from "../lib/media.server";
import { FINDER_DIR, markInterrupted, startRun, stopRun } from "../lib/finder/runner.server";
import { assertPublicUrl } from "../lib/finder/scrapers.server";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { Badge, Banner, Card, Page } from "../components/ui";
import { ProgressBar } from "../components/ProgressBar";

const MODES = ["amazon", "flipkart", "shopify", "custom"] as const;
const MODE_LABEL: Record<string, string> = { amazon: "Amazon.in", flipkart: "Flipkart", shopify: "Shopify store", custom: "Other website" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  await markInterrupted(shop);
  const url = new URL(request.url);
  const show = ["new", "store", "all"].includes(url.searchParams.get("show") ?? "") ? url.searchParams.get("show")! : "new";

  const runs = await prisma.finderRun.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 20, include: { _count: { select: { products: { where: { isNew: true } } } } } });
  const selectedId = url.searchParams.get("run") ?? runs[0]?.id ?? null;
  const run = selectedId ? await prisma.finderRun.findFirst({ where: { id: selectedId, shop } }) : null;
  const products = run
    ? await prisma.finderProduct.findMany({
        where: { runId: run.id, ...(show === "new" ? { isNew: true } : show === "store" ? { isNew: false } : {}) },
        orderBy: { createdAt: "asc" },
        take: 500,
      })
    : [];
  const counts = run ? { fresh: await prisma.finderProduct.count({ where: { runId: run.id, isNew: true } }), images: (await prisma.finderProduct.aggregate({ where: { runId: run.id, isNew: true }, _sum: { imageCount: true } }))._sum.imageCount ?? 0 } : { fresh: 0, images: 0 };

  return {
    show,
    runs: runs.map((r) => ({ id: r.id, category: r.category, brand: r.brand, mode: r.mode, status: r.status, count: r._count.products, at: r.createdAt.toISOString() })),
    run: run && {
      id: run.id, status: run.status, error: run.error, checked: run.checked, maxProducts: run.maxProducts, skippedInStore: run.skippedInStore, skippedEarlier: run.skippedEarlier,
      log: JSON.parse(run.log || "[]") as string[], category: run.category, mode: run.mode,
      zipAll: counts.fresh ? signedFinderUrl(`zip/${run.id}`) : null, csv: counts.fresh ? signedFinderUrl(`csv/${run.id}`) : null,
    },
    counts,
    products: products.map((p) => ({
      id: p.id, title: p.title, brand: p.brand, price: p.price, comparePrice: p.comparePrice, discount: p.discount, link: p.link, imageCount: p.imageCount,
      isNew: p.isNew, reason: p.matchReason,
      thumb: p.thumb && run ? signedFinderUrl(`file/${run.id}/${p.thumb}`) : null,
      zip: p.isNew && p.folder && p.imageCount && run ? signedFinderUrl(`zip/${run.id}/${p.folder}`) : null,
    })),
  };
};

const toNum = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const f = await request.formData();
  const intent = String(f.get("intent"));

  if (intent === "start") {
    const category = String(f.get("category") ?? "").trim().slice(0, 100);
    const mode = String(f.get("mode"));
    const site = String(f.get("site") ?? "").trim().slice(0, 300);
    const minPrice = toNum(f.get("minPrice"));
    const maxPrice = toNum(f.get("maxPrice"));
    if (!category) return { ok: false, message: "Enter a category." };
    if (!MODES.includes(mode as (typeof MODES)[number])) return { ok: false, message: "Choose a website." };
    if ((mode === "shopify" || mode === "custom") && !site) return { ok: false, message: mode === "shopify" ? "Enter the Shopify store URL." : "Enter the website URL." };
    if (site) {
      try {
        assertPublicUrl(site.replace("{query}", "x"));
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    if (Number.isNaN(minPrice) || Number.isNaN(maxPrice)) return { ok: false, message: "Prices must be numbers." };
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) return { ok: false, message: "Min price must be lower than max price." };
    try {
      const id = await startRun(shop, {
        category, brand: String(f.get("brand") ?? "").trim().slice(0, 60), mode, site, minPrice, maxPrice,
        maxProducts: Math.min(200, Math.max(1, Math.round(Number(f.get("maxProducts")) || 30))),
        maxPages: Math.min(10, Math.max(1, Math.round(Number(f.get("maxPages")) || 3))),
        skipEarlier: f.get("skipEarlier") === "on",
      });
      return { ok: true, message: "Search started.", runId: id };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  const id = String(f.get("id") ?? "");
  const run = await prisma.finderRun.findFirst({ where: { id, shop }, select: { id: true } });
  if (!run) return { ok: false, message: "Search not found." };
  if (intent === "stop") {
    stopRun(id);
    return { ok: true, message: "Stopping…" };
  }
  if (intent === "delete") {
    stopRun(id);
    await prisma.finderRun.delete({ where: { id } });
    if (/^[\w-]+$/.test(id)) rmSync(path.join(FINDER_DIR, id), { recursive: true, force: true });
    return { ok: true, message: "Search deleted." };
  }
  return { ok: false, message: "Unknown action." };
};

const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const tone = (s: string) => (s === "done" ? "success" : s === "running" ? "info" : s === "error" ? "critical" : "warning");

export default function ProductScrapper() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const running = d.run?.status === "running";
  useAutoRefresh(running ? 2000 : 20000);
  const [mode, setMode] = useState("amazon");
  const needsSite = mode === "shopify" || mode === "custom";

  return (
    <Page title="Product Scrapper" subtitle="Find in-stock products on other websites. Products you already sell in Shopify are skipped, so you only see new ones.">
      {result && "message" in result && result.message && !result.ok && <Banner tone="critical">{result.message}</Banner>}

      <div className="d-row r-2-1">
        <Card title="Search">
          <Form method="post">
            <div className="fp-fields">
              <label className="o-field fp-full"><span>Category</span>
                <input name="category" placeholder="e.g. running shoes, laptop, kurta" required style={{ width: "100%" }} />
              </label>
              <label className="o-field"><span>Brand (optional)</span><input name="brand" placeholder="All brands" style={{ width: "100%" }} /></label>
              <label className="o-field"><span>Website</span>
                <select name="mode" value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: "100%" }}>
                  {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="o-field"><span>Min price</span><input name="minPrice" type="number" min="0" step="any" placeholder="e.g. 500" style={{ width: "100%" }} /></label>
              <label className="o-field"><span>Max price</span><input name="maxPrice" type="number" min="0" step="any" placeholder="e.g. 2000" style={{ width: "100%" }} /></label>
              {needsSite && (
                <label className="o-field fp-full"><span>{mode === "shopify" ? "Store URL" : "Website URL (use {query} for a search URL)"}</span>
                  <input name="site" type="url" placeholder={mode === "shopify" ? "https://store.com" : "https://site.com/search?q={query}"} required style={{ width: "100%" }} />
                </label>
              )}
              <label className="o-field"><span>Max new products</span><input name="maxProducts" type="number" min="1" max="200" defaultValue={30} style={{ width: "100%" }} /></label>
              <label className="o-field"><span>Max search pages</span><input name="maxPages" type="number" min="1" max="10" defaultValue={3} style={{ width: "100%" }} /></label>
              <label className="fp-full" style={{ display: "block", marginBottom: 12 }}>
                <input type="checkbox" name="skipEarlier" /> Also skip products found in my earlier searches
              </label>
            </div>
            <button name="intent" value="start" disabled={busy || running}><Search size={14} style={{ verticalAlign: -2 }} /> {running ? "A search is running…" : "Find new products"}</button>
          </Form>
        </Card>

        <Card title="Status" action={d.run ? <Badge tone={tone(d.run.status)}>{d.run.status}</Badge> : undefined}>
          {d.run ? (
            <>
              {running && (
                <div style={{ marginBottom: 12 }}>
                  <ProgressBar
                    label={d.run.log.at(-1) ?? "Starting…"}
                    done={d.counts.fresh > 0 ? d.counts.fresh : d.run.checked}
                    total={d.counts.fresh > 0 ? d.run.maxProducts : null}
                    detail={`${d.counts.fresh} of up to ${d.run.maxProducts} new products found · ${d.run.checked} checked · ${d.run.skippedInStore} already in your store`}
                  />
                </div>
              )}
              <div className="fp-log" aria-live="off">{d.run.log.slice(-14).join("\n")}</div>
              {d.run.error && <Banner tone="critical">{d.run.error}</Banner>}
              {running && (
                <Form method="post" style={{ marginTop: 10 }}>
                  <input type="hidden" name="id" value={d.run.id} />
                  <button name="intent" value="stop" className="danger" disabled={busy}><Square size={13} style={{ verticalAlign: -2 }} /> Stop</button>
                </Form>
              )}
            </>
          ) : (
            <p className="d-empty">Waiting for a search.</p>
          )}
        </Card>
      </div>

      {d.run && (
        <div className="d-kpis" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <div className="d-kpi"><div className="d-kpi-label">Products checked</div><div className="d-kpi-value">{d.run.checked}</div></div>
          <div className="d-kpi"><div className="d-kpi-label">New products</div><div className="d-kpi-value">{d.counts.fresh}</div></div>
          <div className="d-kpi"><div className="d-kpi-label">Already in your store</div><div className="d-kpi-value">{d.run.skippedInStore}</div></div>
          <div className="d-kpi"><div className="d-kpi-label">Images saved</div><div className="d-kpi-value">{d.counts.images}</div></div>
        </div>
      )}

      <Card
        title={`Results${d.run ? ` · ${d.run.category}` : ""}`}
        action={
          <div className="o-row">
            <div className="d-range" role="group" aria-label="Show">
              {([["new", "New"], ["store", "Already in store"], ["all", "All"]] as const).map(([k, label]) => (
                <Link key={k} to={`?${new URLSearchParams({ ...(d.run ? { run: d.run.id } : {}), show: k })}`} className={d.show === k ? "on" : ""} preventScrollReset>{label}</Link>
              ))}
            </div>
            {d.run?.zipAll && <a className="fp-btn" href={d.run.zipAll}><Download size={13} style={{ verticalAlign: -2 }} /> All images (ZIP)</a>}
            {d.run?.csv && <a className="fp-btn ghost" href={d.run.csv}>CSV</a>}
          </div>
        }
      >
        {d.products.length === 0 ? (
          <p className="d-empty">
            {running ? "Searching… new products appear here as they are found." : d.show === "new" ? "No new products yet. Enter a category and press Find new products." : "Nothing to show."}
          </p>
        ) : (
          <div className="fp-rows">
            {d.products.map((p) => (
              <div className="fp-row" key={p.id}>
                {p.thumb ? <img src={p.thumb} alt="" className="fp-thumb" loading="lazy" /> : <div className="fp-thumb fp-nothumb" />}
                <div className="fp-main">
                  <a href={p.link} target="_blank" rel="noreferrer noopener" className="fp-title">{p.title}</a>
                  <div className="fp-meta">
                    {p.brand && <span>{p.brand}</span>}
                    <b>{p.price || "—"}</b>
                    {p.comparePrice && <s>{p.comparePrice}</s>}
                    {p.discount > 0 && <Badge tone="success">{p.discount}% off</Badge>}
                    {p.isNew ? <Badge tone="info">New</Badge> : <Badge tone="warning">Already in store</Badge>}
                  </div>
                  {p.reason && <div className="o-muted">{p.reason}</div>}
                </div>
                <div className="fp-side">
                  {p.imageCount > 0 && <span className="o-muted">{p.imageCount} images</span>}
                  {p.zip && <a href={p.zip}>ZIP</a>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Previous searches">
        {d.runs.length === 0 ? (
          <p className="d-empty">None yet.</p>
        ) : (
          <ul className="d-feed">
            {d.runs.map((r) => (
              <li key={r.id}>
                <Link className="d-link" to={`?run=${r.id}`}>
                  <span className="d-feed-main"><b>{r.category}{r.brand ? ` · ${r.brand}` : ""}</b><span>{MODE_LABEL[r.mode] ?? r.mode} · {r.count} new · {when(r.at)}</span></span>
                  <Badge tone={tone(r.status)}>{r.status}</Badge>
                </Link>
                <Form method="post" onSubmit={(e) => { if (!window.confirm("Delete this search and its saved images?")) e.preventDefault(); }}>
                  <input type="hidden" name="id" value={r.id} />
                  <button name="intent" value="delete" className="o-icon" aria-label="Delete search" title="Delete"><Trash2 size={14} /></button>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
