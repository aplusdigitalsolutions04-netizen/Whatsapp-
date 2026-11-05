import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Check, CloudUpload, Download, Play, RotateCcw, Search, Square, Trash2, Undo2, X } from "lucide-react";
import { authenticate } from "../shopify.server";
import { loadImageEditor } from "../lib/image/page-data.server";
import { shopifyCtx } from "../lib/image/shopify-ctx.server";
import { canEditImages, grantedScopes, listStoreProducts, type StoreProduct } from "../lib/image/shopify-images.server";
import { DEFAULT_OPTIONS, LIMITS, PRESETS, type ImageOptions } from "../lib/image/settings";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { Compare, ImageOptionsForm } from "../components/ImageOptionsForm";
import { ImageTabs } from "../components/ImageTabs";
import { Badge, Banner, Card, Page } from "../components/ui";
import styles from "../styles/image-editor.css?url";
import productStyles from "../styles/image-products.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: styles },
  { rel: "stylesheet", href: productStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const ctx = shopifyCtx(session.shop);
  const q = (url.searchParams.get("q") ?? "").slice(0, 80);
  const base = await loadImageEditor(session.shop, url, "store");
  let list: Awaited<ReturnType<typeof listStoreProducts>> = { products: [], hasNext: false, endCursor: null };
  let listError: string | null = null;
  let canEdit = false;
  try {
    // products are only loaded after a search, never as a long list
    if (q.trim()) list = await listStoreProducts(ctx, { q, after: url.searchParams.get("after") });
  } catch (e) {
    listError = (e as Error).message;
  }
  try {
    canEdit = canEditImages(await grantedScopes(ctx));
  } catch {
    canEdit = false;
  }
  return { ...base, q, list, listError, canEdit };
};

const tone = (s: string) => (s === "done" ? "success" : s === "running" ? "info" : s === "error" ? "critical" : s === "stopped" ? "warning" : undefined);
const kb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/image-editor/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(j.error ?? `Request failed (${res.status})`));
  return j;
}

type Pick = { productId: string; productTitle: string; mediaId: string; url: string };
const mainOf = (p: StoreProduct) => p.images.find((i) => i.main) ?? p.images[0];

export default function StoreProducts() {
  const d = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  const search = useFetcher<typeof loader>();
  const sel = d.selected;
  const applyingNow = d.items.some((i) => i.applyStatus === "applying");
  const running = sel?.status === "running" || d.stats.queued > 0 || applyingNow;
  useAutoRefresh(running ? 1500 : 30000);

  // ---- live search (like Shopify's): type, pick a product from the dropdown, it opens below for editing ----
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [opened, setOpened] = useState<StoreProduct[]>([]);
  const results = text.trim() ? (search.data?.list.products ?? []) : [];
  useEffect(() => {
    const q = text.trim();
    if (!q) return;
    const t = setTimeout(() => search.load(`/app/image-products?${new URLSearchParams({ q })}`), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const products = opened;

  // ---- selection ----
  const [picked, setPicked] = useState<Record<string, Pick>>({});
  const toggle = (p: StoreProduct, img: StoreProduct["images"][number]) =>
    setPicked((cur) => {
      const n = { ...cur };
      if (n[img.id]) delete n[img.id];
      else n[img.id] = { productId: p.id, productTitle: p.title, mediaId: img.id, url: img.url };
      return n;
    });
  const selectAllMain = () =>
    setPicked((cur) => {
      const n = { ...cur };
      for (const p of products) {
        const m = mainOf(p);
        if (m) n[m.id] = { productId: p.id, productTitle: p.title, mediaId: m.id, url: m.url };
      }
      return n;
    });
  const openProduct = (p: StoreProduct) => {
    setOpened((cur) => (cur.some((x) => x.id === p.id) ? cur : [p, ...cur]));
    const m = mainOf(p);
    if (m) setPicked((cur) => (cur[m.id] ? cur : { ...cur, [m.id]: { productId: p.id, productTitle: p.title, mediaId: m.id, url: m.url } }));
    setText("");
    setFocus(false);
  };
  const closeProduct = (p: StoreProduct) => {
    setOpened((cur) => cur.filter((x) => x.id !== p.id));
    setPicked((cur) => Object.fromEntries(Object.entries(cur).filter(([, v]) => v.productId !== p.id)));
  };
  const pickedList = Object.values(picked);
  const productCount = new Set(pickedList.map((x) => x.productId)).size;

  // ---- options + start ----
  const [opts, setOpts] = useState<ImageOptions>({ ...DEFAULT_OPTIONS, ...PRESETS[0].options } as ImageOptions);
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ before: string; after: string; title: string } | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const guard = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startEdit = () =>
    guard("Downloading originals…", async () => {
      const r = (await api("store-create", { name: name || `Store photos ${new Date().toLocaleDateString()}`, options: opts, images: pickedList })) as { id: string; added: number; failed: { error: string }[] };
      await api(`start/${r.id}`);
      setPicked({});
      if (r.failed.length) setNotice(`${r.failed.length} image${r.failed.length === 1 ? "" : "s"} could not be downloaded: ${r.failed[0].error}`);
      window.history.replaceState(null, "", `?job=${r.id}`);
      await revalidate();
    });
  const act = (op: string, id: string) =>
    guard(op, async () => {
      await api(`${op}/${id}`);
      await revalidate();
    });
  const apply = (itemIds?: string[]) => {
    const n = itemIds?.length ?? readyToApply;
    if (!window.confirm(`Replace ${n} image${n === 1 ? "" : "s"} in your Shopify store with the edited version?\n\nThe original of each image is saved first, so you can restore it with one click.`)) return;
    void guard("Applying…", async () => {
      await api(`apply/${sel!.id}`, { itemIds });
      await revalidate();
    });
  };
  const restore = (it: (typeof d.items)[number]) => {
    if (!window.confirm(`Put the original image back for "${it.productTitle}"?`)) return;
    void guard("Restoring…", async () => {
      await api("restore", { mediaId: it.mediaId });
      setNotice("The original image was restored in Shopify.");
      await revalidate();
    });
  };

  const done = sel?.counts.done ?? 0;
  const failed = sel?.counts.error ?? 0;
  const remaining = sel ? sel.counts.queued + sel.counts.running : 0;
  const pct = sel && sel.total ? Math.round(((done + failed) / sel.total) * 100) : 0;
  const canApplyItem = (s: string) => ["", "failed", "restored"].includes(s);
  const readyToApply = d.items.filter((i) => i.status === "done" && canApplyItem(i.applyStatus)).length;
  const appliedCount = d.items.filter((i) => i.applyStatus === "applied").length;

  return (
    <Page title="Image Editor" subtitle="Edit the photos of products that are already in your store, then put the result back into Shopify.">
      <ImageTabs active="store" />
      {!d.canEdit && (
        <Banner tone="warning">
          The app does not have permission to change product images yet. You can still pick products and preview edits, but <b>Apply to Shopify</b> needs the new permission
          (write_products, write_files). Restart the app and approve the permission update in your Shopify admin.
        </Banner>
      )}
      {error && <Banner tone="critical">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {d.listError && <Banner tone="critical">Could not load products from Shopify: {d.listError}</Banner>}
      {d.stats.lastError && <Banner tone="warning">{d.stats.lastError}</Banner>}

      <Card title="1. Choose images" action={<Badge>{pickedList.length} selected</Badge>}>
        <div className="sp-search-wrap">
          <Search size={16} className="sp-search-icon" />
          <input
            className="sp-search-input" value={text} placeholder="Search products" aria-label="Search products" autoComplete="off"
            onChange={(e) => setText(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
          />
          {focus && text.trim() && (
            <ul className="sp-drop" role="listbox">
              {search.state !== "idle" && results.length === 0 && <li className="sp-drop-note">Searching…</li>}
              {search.state === "idle" && results.length === 0 && <li className="sp-drop-note">{search.data?.listError ? `Could not search: ${search.data.listError}` : "No products found."}</li>}
              {results.map((p) => (
                <li key={p.id} role="option" aria-selected={opened.some((x) => x.id === p.id)}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => openProduct(p)}>
                    {mainOf(p) ? <img src={mainOf(p)!.thumb} alt="" /> : <span className="sp-noimg" />}
                    <span className="grow">{p.title}</span>
                    <small>{p.images.length} image{p.images.length === 1 ? "" : "s"}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="ie-hint" style={{ marginTop: 0, marginBottom: 12 }}>The main image is selected when a product opens. Click any picture to add or remove it (up to {LIMITS.maxFiles} at a time).</p>
        {products.length > 1 && (
          <div className="o-row" style={{ marginBottom: 10 }}>
            <button type="button" className="ghost small" onClick={selectAllMain}>Select every main image</button>
          </div>
        )}
        {products.length === 0 ? (
          <p className="d-empty">Search for a product above and click it. Its images open here so you can choose which ones to edit.</p>
        ) : (
          <div className="sp-list">
            {products.map((p) => {
              const any = p.images.some((i) => picked[i.id]);
              const main = mainOf(p);
              return (
                <div className={`sp-prod${any ? " has-sel" : ""}`} key={p.id}>
                  <div className="sp-head">
                    <b className="grow" title={p.title}>{p.title}</b>
                    {p.status !== "ACTIVE" && <Badge tone="warning">{p.status.toLowerCase()}</Badge>}
                    <span className="o-muted">{p.images.length} image{p.images.length === 1 ? "" : "s"}</span>
                    {main && <button type="button" className="ghost small" onClick={() => toggle(p, main)}>{picked[main.id] ? "Unselect main image" : "Select main image"}</button>}
                    <button type="button" className="ghost small" onClick={() => closeProduct(p)} aria-label={`Close ${p.title}`}><X size={12} /></button>
                  </div>
                  {p.images.length === 0 ? (
                    <div className="sp-empty-thumb">This product has no images.</div>
                  ) : (
                    <div className="sp-imgs">
                      {p.images.map((img) => (
                        <button type="button" key={img.id} className={`sp-img${picked[img.id] ? " on" : ""}`} onClick={() => toggle(p, img)} disabled={!img.ready} aria-pressed={Boolean(picked[img.id])} title={img.alt || p.title}>
                          <img src={img.thumb} alt={img.alt || p.title} loading="lazy" />
                          <span className="tick">{picked[img.id] ? <Check size={11} /> : null}</span>
                          {img.main && <span className="tag">Main</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div ref={formRef}>
        <Card title="2. Choose the edit">
          <ImageOptionsForm opts={opts} setOpts={setOpts} preset={preset} setPreset={setPreset} lockFormat />
          <div className="o-row" style={{ marginTop: 14 }}>
            <input placeholder="Batch name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} aria-label="Batch name" />
            <button disabled={pickedList.length === 0 || busy !== null} onClick={startEdit}>
              <Play size={14} style={{ verticalAlign: -2 }} /> {busy === "Downloading originals…" ? busy : `Edit ${pickedList.length || ""} image${pickedList.length === 1 ? "" : "s"}`}
            </button>
            <span className="o-muted">Nothing changes in Shopify until you press Apply.</span>
          </div>
        </Card>
      </div>

      {sel && (
        <Card title={`3. Review and apply: ${sel.name}`} action={<Badge tone={tone(sel.status)}>{sel.status}</Badge>}>
          <div className="ie-progress big"><i style={{ width: `${pct}%` }} /></div>
          <div className="ie-job-stats">
            <span><b>{done}</b> edited</span>
            <span><b>{remaining}</b> waiting</span>
            <span className={failed ? "bad" : ""}><b>{failed}</b> failed</span>
            <span><b>{appliedCount}</b> updated in Shopify</span>
          </div>
          <div className="o-row" style={{ margin: "10px 0 14px" }}>
            <button disabled={!d.canEdit || readyToApply === 0 || busy !== null} onClick={() => apply()} title={d.canEdit ? "" : "The app needs the write_files permission first"}>
              <CloudUpload size={14} style={{ verticalAlign: -2 }} /> Apply {readyToApply || ""} to Shopify
            </button>
            {sel.status === "running" && <button className="ghost" onClick={() => act("stop", sel.id)}><Square size={13} style={{ verticalAlign: -2 }} /> Stop</button>}
            {sel.status === "stopped" && remaining > 0 && <button className="ghost" onClick={() => act("start", sel.id)}><Play size={13} style={{ verticalAlign: -2 }} /> Resume</button>}
            {failed > 0 && sel.status !== "running" && <button className="ghost" onClick={() => act("retry", sel.id)}><RotateCcw size={13} style={{ verticalAlign: -2 }} /> Retry {failed} failed</button>}
            {sel.zip && <a className="ie-zip" href={sel.zip}><Download size={14} /> Download edited (ZIP)</a>}
            <button className="danger" onClick={() => { if (window.confirm("Delete this batch? Images already updated in Shopify stay as they are, and their saved originals are kept.")) void act("delete", sel.id); }}>
              <Trash2 size={13} style={{ verticalAlign: -2 }} /> Delete batch
            </button>
          </div>
          <div className="ie-grid">
            {d.items.map((it) => (
              <figure className={`ie-card ${it.status}`} key={it.id}>
                <div className="ie-thumb">
                  {it.thumb ? <img src={it.thumb} alt={it.productTitle} loading="lazy" /> : <span>{it.status === "error" ? "Failed" : it.status === "running" ? "Working…" : "Waiting"}</span>}
                </div>
                <figcaption>
                  <b title={it.productTitle}>{it.productTitle || it.name}</b>
                  {it.status === "done" && <small>{it.width}x{it.height} · {kb(it.inBytes)} to {kb(it.outBytes)}</small>}
                  {it.applyStatus && <span className={`app ${it.applyStatus}`}>{it.applyStatus === "applied" ? "Updated in Shopify" : it.applyStatus === "applying" ? "Updating…" : it.applyStatus === "failed" ? "Not updated" : "Original restored"}</span>}
                  {it.applyError && <small className="err">{it.applyError}</small>}
                  {it.error && <small className="err">{it.error}</small>}
                  {it.note && <small className="warn">{it.note}</small>}
                  {it.status === "done" && (
                    <div className="ie-card-actions">
                      {it.orig && it.result && <button className="ghost small" onClick={() => setCompare({ before: it.orig!, after: it.result!, title: it.productTitle || it.name })}>Compare</button>}
                      {d.canEdit && canApplyItem(it.applyStatus) && <button className="small" disabled={busy !== null} onClick={() => apply([it.id])}>Apply</button>}
                      {d.canEdit && it.hasBackup && it.applyStatus === "applied" && (
                        <button className="ghost small" disabled={busy !== null} onClick={() => restore(it)}><Undo2 size={12} style={{ verticalAlign: -2 }} /> Restore original</button>
                      )}
                    </div>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        </Card>
      )}

      <Card title="Previous batches">
        {d.jobs.length === 0 ? (
          <p className="d-empty">No batches yet. Choose some product images above.</p>
        ) : (
          <ul className="d-feed">
            {d.jobs.map((j) => (
              <li key={j.id}>
                <Link className="d-link" to={`?job=${j.id}`}>
                  <span className="d-feed-main">
                    <b>{j.name}</b>
                    <span>{j.counts.done} edited{j.counts.error ? `, ${j.counts.error} failed` : ""} of {j.total} · {new Date(j.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </span>
                  <Badge tone={tone(j.status)}>{j.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pickedList.length > 0 && (
        <div className="sp-bar" role="status">
          <span><b>{pickedList.length}</b> image{pickedList.length === 1 ? "" : "s"} from <b>{productCount}</b> product{productCount === 1 ? "" : "s"} selected</span>
          <span className="grow" />
          <button type="button" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Choose the edit</button>
        </div>
      )}
      {compare && <Compare {...compare} onClose={() => setCompare(null)} />}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
