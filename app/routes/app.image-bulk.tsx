import { useRef, useState } from "react";
import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { FileArchive, Play, RotateCcw } from "lucide-react";
import { authenticate } from "../shopify.server";
import { shopifyCtx } from "../lib/image/shopify-ctx.server";
import { canEditImages, grantedScopes } from "../lib/image/shopify-images.server";
import { parseZip, type ParsedZip } from "../lib/image/bulk-zip";
import type { SkuMatch, ProductResult } from "../lib/image/bulk-upload.server";
import { ImageTabs } from "../components/ImageTabs";
import { ProgressBar } from "../components/ProgressBar";
import { Badge, Banner, Card, Page } from "../components/ui";
import styles from "../styles/image-editor.css?url";
import productStyles from "../styles/image-products.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: styles },
  { rel: "stylesheet", href: productStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  let canEdit = false;
  try {
    canEdit = canEditImages(await grantedScopes(shopifyCtx(session.shop)));
  } catch {
    canEdit = false;
  }
  return { canEdit };
};

const MAX_ZIP = 400 * 1024 * 1024;
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/image-editor/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(j.error ?? `Request failed (${res.status})`));
  return j as T;
}

type Row = { sku: string; images: ParsedZip["folders"][number]["images"]; match: SkuMatch; run: "idle" | "working" | "done" | "partial" | "failed"; added: number; failed: { position: number; error: string }[]; removed: number; error: string };

export default function BulkUpload() {
  const d = useLoaderData<typeof loader>();
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<ParsedZip["problems"]>([]);
  const [zipName, setZipName] = useState("");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [phase, setPhase] = useState<"idle" | "reading" | "checking" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [queue, setQueue] = useState<string[]>([]); // the SKUs of the upload that is running or just ran
  const input = useRef<HTMLInputElement>(null);

  const patch = (sku: string, p: Partial<Row>) => setRows((cur) => cur.map((r) => (r.sku === sku ? { ...r, ...p } : r)));

  const readZip = async (file: File) => {
    setError(null);
    setRows([]);
    setQueue([]);
    setProblems([]);
    if (!/\.zip$/i.test(file.name)) return setError("Please choose a .zip file.");
    if (file.size > MAX_ZIP) return setError(`The ZIP is larger than ${mb(MAX_ZIP)}. Split it into smaller ZIPs.`);
    setZipName(file.name);
    try {
      setPhase("reading");
      const parsed = parseZip(new Uint8Array(await file.arrayBuffer()));
      setProblems(parsed.problems);
      if (parsed.folders.length === 0) throw new Error("No SKU folders with numbered images (1.jpg, 2.jpg ...) were found in this ZIP.");
      setPhase("checking");
      const { matches } = await postJson<{ matches: SkuMatch[] }>("bulk-check", { skus: parsed.folders.map((f) => f.sku) });
      const bySku = new Map(matches.map((m) => [m.sku.toLowerCase(), m]));
      setRows(parsed.folders.map((f) => ({
        sku: f.sku, images: f.images, run: "idle", added: 0, failed: [], removed: 0, error: "",
        match: bySku.get(f.sku.toLowerCase()) ?? { sku: f.sku, state: "missing", productId: "", title: "", imageCount: 0 },
      })));
    } catch (e) {
      setError((e as Error).message.includes("Invalid") || (e as Error).message.includes("zip") ? `This ZIP could not be read: ${(e as Error).message}` : (e as Error).message);
    } finally {
      setPhase("idle");
    }
  };

  const uploadOne = async (r: Row) => {
    patch(r.sku, { run: "working", error: "", failed: [], added: 0, removed: 0 });
    try {
      const form = new FormData();
      form.set("productId", r.match.productId);
      form.set("sku", r.sku);
      form.set("mode", mode);
      for (const img of r.images) form.set(`image-${img.position}`, new File([img.data as BlobPart], img.name, { type: `image/${img.ext === "jpg" ? "jpeg" : img.ext}` }));
      const res = await fetch("/api/image-editor/bulk-product", { method: "POST", body: form });
      const j = (await res.json().catch(() => ({}))) as Partial<ProductResult> & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
      const failed = j.failed ?? [];
      patch(r.sku, { run: (j.added ?? 0) === 0 ? "failed" : failed.length ? "partial" : "done", added: j.added ?? 0, failed, removed: j.removed ?? 0, error: (j.added ?? 0) === 0 ? failed[0]?.error ?? "Nothing was uploaded." : "" });
    } catch (e) {
      patch(r.sku, { run: "failed", error: (e as Error).message });
    }
  };

  const runUpload = async (only?: Row[]) => {
    const todo = only ?? rows.filter((r) => r.match.state === "found" && r.run !== "done");
    if (todo.length === 0) return;
    if (mode === "replace" && !window.confirm(`Replace ALL existing images on ${todo.length} product${todo.length === 1 ? "" : "s"} with the images from the ZIP?\n\nThe old images are removed from those products and cannot be restored from this app.`)) return;
    setError(null);
    setQueue(todo.map((r) => r.sku));
    setPhase("uploading");
    let next = 0;
    const lane = async () => { while (next < todo.length) await uploadOne(todo[next++]); };
    await Promise.all([lane(), lane()]);
    setPhase("idle");
  };

  const found = rows.filter((r) => r.match.state === "found");
  const skipped = rows.length - found.length;
  const done = rows.filter((r) => r.run === "done" || r.run === "partial" || r.run === "failed");
  const finished = phase === "idle" && done.length > 0 && done.length === rows.filter((r) => r.match.state === "found" && r.run !== "idle").length;
  const okProducts = rows.filter((r) => r.run === "done").length;
  const partial = rows.filter((r) => r.run === "partial").length;
  const failedProducts = rows.filter((r) => r.run === "failed").length;
  const totalImages = found.reduce((a, r) => a + r.images.length, 0);
  const addedImages = rows.reduce((a, r) => a + r.added, 0);
  const failedImages = rows.reduce((a, r) => a + (r.run === "failed" && r.failed.length === 0 ? r.images.length : r.failed.filter((f) => f.position > 0).length), 0);
  const retryable = rows.filter((r) => r.run === "failed" || r.run === "partial");
  const busy = phase !== "idle";

  const badge = (r: Row) => {
    if (r.match.state === "missing") return <Badge tone="critical">SKU not found</Badge>;
    if (r.match.state === "ambiguous") return <Badge tone="warning">Several products</Badge>;
    if (r.run === "working") return <Badge tone="info">Uploading…</Badge>;
    if (r.run === "done") return <Badge tone="success">Done</Badge>;
    if (r.run === "partial") return <Badge tone="warning">Some failed</Badge>;
    if (r.run === "failed") return <Badge tone="critical">Failed</Badge>;
    return <Badge>Ready</Badge>;
  };

  return (
    <Page title="Image Editor" subtitle="Upload many product images at once from a ZIP: one folder per SKU, files numbered by position.">
      <ImageTabs active="bulk" />
      {!d.canEdit && (
        <Banner tone="warning">
          The app does not have permission to change product images yet (write_products, write_files). You can still check a ZIP, but uploading needs the permission. Restart the app and approve the update in your Shopify admin.
        </Banner>
      )}
      {error && <Banner tone="critical">{error}</Banner>}

      <Card title="1. Choose your ZIP">
        <div
          className={`ie-drop${drag ? " on" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void readZip(f); }}
        >
          <FileArchive size={30} />
          <b>{phase === "reading" ? "Reading the ZIP…" : phase === "checking" ? "Looking up the SKUs in Shopify…" : zipName || "Drop a ZIP here"}</b>
          <span>Each folder is a SKU, each image is its position (1.jpg, 2.jpg, 3.png). WebP works too. Maximum {mb(MAX_ZIP)}.</span>
          <label className="ie-pick"><FileArchive size={14} /> Choose ZIP
            <input ref={input} type="file" accept=".zip,application/zip" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void readZip(f); e.target.value = ""; }} />
          </label>
        </div>
        {(phase === "reading" || phase === "checking") && (
          <div style={{ marginTop: 12 }}>
            <ProgressBar label={phase === "reading" ? "Reading the ZIP and checking the images" : "Looking up the SKUs in Shopify"} detail={zipName} />
          </div>
        )}
        <pre className="bulk-example" aria-label="Example ZIP layout">{`products.zip
  ├─ SKU-1001/  1.jpg  2.jpg  3.jpg
  ├─ SKU-1002/  1.png  2.png
  └─ SKU-1003/  1.webp`}</pre>
        {problems.length > 0 && (
          <div className="ie-warn">
            <b>{problems.length} file{problems.length === 1 ? " was" : "s were"} ignored:</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {problems.slice(0, 8).map((p) => <li key={p.path}>{p.path}: {p.reason}</li>)}
              {problems.length > 8 && <li>and {problems.length - 8} more</li>}
            </ul>
          </div>
        )}
      </Card>

      {rows.length > 0 && (
        <Card title="2. Check and upload" action={<Badge>{found.length} of {rows.length} SKUs match a product</Badge>}>
          <fieldset className="bulk-mode" disabled={busy}>
            <legend>If a product already has images</legend>
            <label className="ie-check"><input type="radio" name="mode" checked={mode === "append"} onChange={() => setMode("append")} /> <span><b>Keep the old images</b> and add the new ones after them (safe)</span></label>
            <label className="ie-check"><input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> <span><b>Remove the old images</b> and use only the new ones. The first image (1) becomes the main image.</span></label>
          </fieldset>

          <div className="bulk-table" role="table" aria-label="SKUs in the ZIP">
            <div className="bulk-row head" role="row"><span>SKU</span><span>Product</span><span>New images</span><span>Now in Shopify</span><span>Status</span></div>
            {rows.map((r) => (
              <div className={`bulk-row ${r.match.state !== "found" ? "skip" : ""}`} role="row" key={r.sku}>
                <b>{r.sku}</b>
                <span title={r.match.title}>{r.match.title || (r.match.state === "missing" ? "No product has this SKU" : "")}</span>
                <span>{r.images.map((i) => i.position).join(", ")}</span>
                <span>{r.match.state === "found" ? r.match.imageCount : "-"}</span>
                <span>
                  {badge(r)}
                  {r.run === "partial" && <small className="err"> {r.added} added, {r.failed.length} failed</small>}
                  {r.run === "done" && <small className="o-muted"> {r.added} added{r.removed ? `, ${r.removed} old removed` : ""}</small>}
                  {r.error && <small className="err"> {r.error}</small>}
                </span>
                {r.failed.length > 0 && r.run !== "failed" && (
                  <ul className="bulk-fails">{r.failed.map((f) => <li key={f.position + f.error}>{f.position > 0 ? `Image ${f.position}: ` : ""}{f.error}</li>)}</ul>
                )}
              </div>
            ))}
          </div>

          {queue.length > 0 && (
            <div style={{ marginTop: 14 }} aria-live="polite">
              <ProgressBar
                label={phase === "uploading" ? "Uploading images to your products" : "Upload finished"}
                done={rows.filter((r) => queue.includes(r.sku) && (r.run === "done" || r.run === "partial" || r.run === "failed")).length}
                total={queue.length}
                running={phase === "uploading"}
                tone={phase !== "uploading" ? (failedProducts || partial ? "bad" : "ok") : undefined}
                detail={`products done · ${addedImages} image${addedImages === 1 ? "" : "s"} added · ${failedProducts} product${failedProducts === 1 ? "" : "s"} failed`}
              />
            </div>
          )}
          <div className="o-row" style={{ marginTop: 14 }}>
            <button disabled={!d.canEdit || busy || found.length === 0 || rows.every((r) => r.match.state !== "found" || r.run === "done")} onClick={() => void runUpload()}>
              <Play size={14} style={{ verticalAlign: -2 }} /> {phase === "uploading" ? "Uploading…" : `Upload ${totalImages} image${totalImages === 1 ? "" : "s"} to ${found.length} product${found.length === 1 ? "" : "s"}`}
            </button>
            {retryable.length > 0 && !busy && d.canEdit && <button className="ghost" onClick={() => void runUpload(retryable)}><RotateCcw size={13} style={{ verticalAlign: -2 }} /> Retry {retryable.length} with problems</button>}
            {skipped > 0 && <span className="ie-warn-inline">{skipped} SKU{skipped === 1 ? "" : "s"} will be skipped (not found or shared by several products)</span>}
          </div>
        </Card>
      )}

      {finished && (
        <Card title="Result">
          <div className="bulk-result">
            <div><b>{okProducts}</b><span>products done</span></div>
            <div className={partial ? "bad" : ""}><b>{partial}</b><span>with some failed</span></div>
            <div className={failedProducts ? "bad" : ""}><b>{failedProducts}</b><span>products failed</span></div>
            <div><b>{addedImages}</b><span>images uploaded</span></div>
            <div className={failedImages ? "bad" : ""}><b>{failedImages}</b><span>images failed</span></div>
            <div className={skipped ? "bad" : ""}><b>{skipped}</b><span>SKUs skipped</span></div>
          </div>
          <p className="ie-hint">Failed rows above show the reason. Fix the problem (or the file) and press Retry.</p>
        </Card>
      )}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
