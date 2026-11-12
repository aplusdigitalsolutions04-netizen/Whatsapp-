import { useCallback, useState } from "react";
import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Download, FolderPlus, ImagePlus, Play, RotateCcw, Square, Trash2, UploadCloud } from "lucide-react";
import { authenticate } from "../shopify.server";
import { loadImageEditor } from "../lib/image/page-data.server";
import { DEFAULT_OPTIONS, LIMITS, PRESETS, type ImageOptions } from "../lib/image/settings";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { Compare, ImageOptionsForm } from "../components/ImageOptionsForm";
import { ImageTabs } from "../components/ImageTabs";
import { Badge, Banner, Card, Page } from "../components/ui";
import styles from "../styles/image-editor.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return loadImageEditor(session.shop, new URL(request.url));
};

// ---------- small helpers ----------
const bytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const tone = (s: string) => (s === "done" ? "success" : s === "running" ? "info" : s === "error" ? "critical" : s === "stopped" ? "warning" : undefined);
const eta = (seconds: number) => (seconds < 60 ? `${Math.max(1, Math.round(seconds))}s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`);

async function api(path: string, body?: unknown, form?: FormData): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/image-editor/${path}`, form ? { method: "POST", body: form } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(j.error ?? `Request failed (${res.status})`));
  return j;
}

type Picked = { file: File; folder: string };

/** Files from a drop, including folders (one level of folder name is kept for the ZIP). */
async function collectDropped(dt: DataTransfer): Promise<Picked[]> {
  const out: Picked[] = [];
  const walk = async (entry: FileSystemEntry, top: string) => {
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file: f, folder: top });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, top || entry.name);
      }
    }
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (entries.length) for (const e of entries) await walk(e, "");
  else for (const f of dt.files) out.push({ file: f, folder: "" });
  return out;
}

const isImageName = (n: string) => /\.(jpe?g|png|webp)$/i.test(n);

export default function ImageEditor() {
  const d = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  const running = d.selected?.status === "running" || d.stats.busy > 0 || d.stats.queued > 0;
  useAutoRefresh(running ? 1500 : 20000);

  // ---- new batch ----
  const [opts, setOpts] = useState<ImageOptions>({ ...DEFAULT_OPTIONS, ...PRESETS[0].options } as ImageOptions);
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<{ step: "idle" | "uploading" | "starting"; done: number; total: number }>({ step: "idle", done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [compare, setCompare] = useState<{ before: string; after: string; title: string } | null>(null);

  const addFiles = useCallback((list: Picked[]) => {
    const ok = list.filter((p) => isImageName(p.file.name) && p.file.size > 0 && p.file.size <= LIMITS.maxFileBytes);
    setSkipped((n) => n + list.length - ok.length);
    setPicked((cur) => [...cur, ...ok].slice(0, LIMITS.maxFiles));
  }, []);

  const startBatch = async () => {
    setError(null);
    try {
      setPhase({ step: "uploading", done: 0, total: picked.length });
      const { id } = (await api("create", { name: name || `Batch ${new Date().toLocaleDateString()}`, options: opts })) as { id: string };
      let next = 0;
      let done = 0;
      let failed = 0;
      const lane = async () => {
        while (next < picked.length) {
          const p = picked[next++];
          const form = new FormData();
          form.set("file", p.file);
          form.set("folder", p.folder);
          try {
            await api(`upload/${id}`, undefined, form);
          } catch {
            failed++;
          }
          setPhase({ step: "uploading", done: ++done, total: picked.length });
        }
      };
      await Promise.all(Array.from({ length: 4 }, lane));
      if (failed === picked.length) throw new Error("None of the photos could be uploaded.");
      setPhase({ step: "starting", done, total: picked.length });
      await api(`start/${id}`);
      setPicked([]);
      setSkipped(failed);
      window.history.replaceState(null, "", `?job=${id}`);
      await revalidate();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPhase({ step: "idle", done: 0, total: 0 });
    }
  };

  const act = async (op: string, id: string) => {
    setError(null);
    try {
      await api(`${op}/${id}`);
      await revalidate();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sel = d.selected;
  const finished = sel ? sel.counts.done + sel.counts.error : 0;
  const pct = sel && sel.total ? Math.round((finished / sel.total) * 100) : 0;
  const remaining = sel ? sel.counts.queued + sel.counts.running : 0;
  const etaText = d.stats.perMinute > 0 && remaining > 0 ? eta((remaining / d.stats.perMinute) * 60) : null;
  const saved = sel && sel.inBytes > 0 ? Math.max(0, Math.round((1 - sel.outBytes / sel.inBytes) * 100)) : 0;
  const filterLink = (s: string) => `?${new URLSearchParams({ ...(sel ? { job: sel.id } : {}), show: s })}`;
  const busy = phase.step !== "idle";
  const canStart = picked.length > 0 && !busy;

  return (
    <Page title="Image Editor" subtitle="Clean up product photos in bulk: remove backgrounds, resize, compress and download everything as a ZIP.">
      <ImageTabs active="upload" />
      {error && <Banner tone="critical">{error}</Banner>}
      {d.stats.lastError && <Banner tone="warning">{d.stats.lastError}</Banner>}


      {/* new batch */}
      <Card title="New batch">
        <div
          className={`ie-drop${drag ? " on" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={async (e) => { e.preventDefault(); setDrag(false); addFiles(await collectDropped(e.dataTransfer)); }}
        >
          <UploadCloud size={30} />
          <b>Drop photos or folders here</b>
          <span>JPG, PNG or WebP, up to {LIMITS.maxFileBytes / 1024 / 1024} MB each, {LIMITS.maxFiles} photos per batch</span>
          <div className="o-row" style={{ justifyContent: "center" }}>
            <label className="ie-pick"><ImagePlus size={14} /> Choose photos
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])].map((f) => ({ file: f, folder: "" }))); e.target.value = ""; }} />
            </label>
            <label className="ie-pick"><FolderPlus size={14} /> Choose a folder
              <input type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(e) => { addFiles([...(e.target.files ?? [])].map((f) => ({ file: f, folder: f.webkitRelativePath.split("/")[0] ?? "" }))); e.target.value = ""; }} />
            </label>
          </div>
        </div>
        {(picked.length > 0 || skipped > 0) && (
          <p className="ie-picked">
            <b>{picked.length}</b> photo{picked.length === 1 ? "" : "s"} ready ({bytes(picked.reduce((a, p) => a + p.file.size, 0))})
            {skipped > 0 && <span className="ie-warn-inline"> · {skipped} skipped (wrong type, empty, or too big)</span>}
            {picked.length > 0 && <button className="ghost small" onClick={() => { setPicked([]); setSkipped(0); }} style={{ marginLeft: 10 }}>Clear</button>}
          </p>
        )}

        <ImageOptionsForm opts={opts} setOpts={setOpts} preset={preset} setPreset={setPreset} />

        <div className="o-row" style={{ marginTop: 14 }}>
          <input placeholder="Batch name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} aria-label="Batch name" />
          <button disabled={!canStart} onClick={startBatch}><Play size={14} style={{ verticalAlign: -2 }} /> {busy ? (phase.step === "uploading" ? `Uploading ${phase.done} / ${phase.total}…` : "Starting…") : `Process ${picked.length || ""} photo${picked.length === 1 ? "" : "s"}`}</button>
          <span className="o-muted">Photos are edited one at a time, so a big batch takes a little longer.</span>
        </div>
        {busy && <div className="ie-progress"><i style={{ width: `${phase.total ? Math.round((phase.done / phase.total) * 100) : 0}%` }} /></div>}
      </Card>

      {/* current batch */}
      {sel && (
        <Card
          title={`${sel.name}`}
          action={<Badge tone={tone(sel.status)}>{sel.status}</Badge>}
        >
          <div className="ie-progress big"><i style={{ width: `${pct}%` }} /></div>
          <div className="ie-job-stats">
            <span><b>{sel.counts.done}</b> done</span>
            <span><b>{remaining}</b> waiting</span>
            <span className={sel.counts.error ? "bad" : ""}><b>{sel.counts.error}</b> failed</span>
            <span><b>{pct}%</b> of {sel.total}</span>
            {sel.status === "running" && etaText && <span>about <b>{etaText}</b> left</span>}
            {saved > 0 && <span>files are <b>{saved}%</b> smaller ({bytes(sel.inBytes)} to {bytes(sel.outBytes)})</span>}
          </div>
          <div className="o-row" style={{ margin: "10px 0 14px" }}>
            {sel.status === "running" && <button className="ghost" onClick={() => act("stop", sel.id)}><Square size={13} style={{ verticalAlign: -2 }} /> Stop</button>}
            {sel.status === "stopped" && remaining > 0 && <button onClick={() => act("start", sel.id)}><Play size={13} style={{ verticalAlign: -2 }} /> Resume</button>}
            {sel.counts.error > 0 && sel.status !== "running" && <button className="ghost" onClick={() => act("retry", sel.id)}><RotateCcw size={13} style={{ verticalAlign: -2 }} /> Retry {sel.counts.error} failed</button>}
            {sel.zip && <a className="ie-zip" href={sel.zip}><Download size={14} /> Download all (ZIP)</a>}
            <button className="danger" onClick={() => { if (window.confirm("Delete this batch and all its photos?")) void act("delete", sel.id); }}><Trash2 size={13} style={{ verticalAlign: -2 }} /> Delete</button>
          </div>
          <div className="d-range" role="group" aria-label="Show" style={{ marginBottom: 12 }}>
            {([["all", "All"], ["done", "Done"], ["waiting", "Waiting"], ["failed", "Failed"]] as const).map(([k, label]) => (
              <Link key={k} to={filterLink(k)} className={d.show === k ? "on" : ""} preventScrollReset>{label}</Link>
            ))}
          </div>
          {d.items.length === 0 ? <p className="d-empty">Nothing to show here.</p> : (
            <div className="ie-grid">
              {d.items.map((it) => (
                <figure className={`ie-card ${it.status}`} key={it.id}>
                  <div className="ie-thumb">
                    {it.thumb ? <img src={it.thumb} alt={it.outName ?? it.name} loading="lazy" /> : <span>{it.status === "error" ? "Failed" : it.status === "running" ? "Working…" : "Waiting"}</span>}
                  </div>
                  <figcaption>
                    <b title={it.name}>{it.name}</b>
                    {it.folder && <small>{it.folder}</small>}
                    {it.status === "done" ? <small>{it.width}x{it.height} · {bytes(it.inBytes)} to {bytes(it.outBytes)}</small> : null}
                    {it.error && <small className="err">{it.error}</small>}
                    {it.note && <small className="warn">{it.note}</small>}
                    {it.status === "done" && (
                      <div className="ie-card-actions">
                        {it.orig && it.result && <button className="ghost small" onClick={() => setCompare({ before: it.orig!, after: it.result!, title: it.name })}>Compare</button>}
                        {it.download && <a href={it.download}>Download</a>}
                      </div>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* history */}
      <Card title="Previous batches">
        {d.jobs.length === 0 ? <p className="d-empty">No batches yet. Drop some photos above to start.</p> : (
          <ul className="d-feed">
            {d.jobs.map((j) => (
              <li key={j.id}>
                <Link className="d-link" to={`?job=${j.id}`}>
                  <span className="d-feed-main"><b>{j.name}</b><span>{j.counts.done} done{j.counts.error ? `, ${j.counts.error} failed` : ""} of {j.total} · {new Date(j.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></span>
                  <Badge tone={tone(j.status)}>{j.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {compare && <Compare {...compare} onClose={() => setCompare(null)} />}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
