import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ArrowRight, CheckCircle2, ChevronDown, Download, FileUp, ImageOff, RotateCcw, ScanSearch, Search, Undo2, X } from "lucide-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { signedSeoUrl } from "../lib/media.server";
import { getTask } from "../lib/progress.server";
import { isRunning, latestScan } from "../lib/seo/seo-store.server";
import { RULES, ruleById, type Issue } from "../lib/seo/rules";
import type { Change, Skipped } from "../lib/seo/csv";
import { Badge, Banner, Card, Page } from "../components/ui";
import { ProgressBar } from "../components/ProgressBar";
import styles from "../styles/seo.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

const PAGE = 25;
const FILTERS = [["all", "All"], ["errors", "With errors"], ["warn", "Only warnings"], ["clean", "No issues"]] as const;
const TABS = [["overview", "Overview"], ["products", "Products"], ["fix", "Bulk fix"]] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const f = FILTERS.some(([k]) => k === url.searchParams.get("f")) ? url.searchParams.get("f")! : "all";
  const rule = ruleById(url.searchParams.get("rule") ?? "") ? url.searchParams.get("rule")! : "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const askedTab = url.searchParams.get("tab") ?? "";
  const tab = TABS.some(([k]) => k === askedTab) ? askedTab : q || rule || f !== "all" || page > 1 ? "products" : "overview";

  const all = await prisma.seoProduct.findMany({ where: { shop }, select: { score: true, errors: true, warnings: true, issues: true } });
  const byRule = new Map<string, number>();
  let withErrors = 0;
  let warnOnly = 0;
  let clean = 0;
  let fixable = 0;
  for (const r of all) {
    if (r.errors > 0) withErrors++;
    else if (r.warnings > 0) warnOnly++;
    else clean++;
    let csvFixable = false;
    for (const i of JSON.parse(r.issues || "[]") as Issue[]) {
      byRule.set(i.rule, (byRule.get(i.rule) ?? 0) + 1);
      if (ruleById(i.rule)?.fixable === "csv") csvFixable = true;
    }
    if (csvFixable) fixable++;
  }
  const avg = all.length ? Math.round(all.reduce((n, r) => n + r.score, 0) / all.length) : 0;

  const where = {
    shop,
    ...(q ? { OR: [{ title: { contains: q } }, { handle: { contains: q } }, { vendor: { contains: q } }] } : {}),
    ...(f === "errors" ? { errors: { gt: 0 } } : f === "warn" ? { errors: 0, warnings: { gt: 0 } } : f === "clean" ? { errors: 0, warnings: 0 } : {}),
    ...(rule ? { issues: { contains: `"rule":"${rule}"` } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.seoProduct.count({ where }),
    prisma.seoProduct.findMany({ where, orderBy: [{ score: "asc" }, { title: "asc" }], skip: (page - 1) * PAGE, take: PAGE }),
  ]);

  const batches = await prisma.seoBatch.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 8 });
  const counts = await prisma.seoChange.groupBy({ by: ["batchId", "status"], where: { batchId: { in: batches.map((b) => b.id) } }, _count: { _all: true } });
  const scan = await latestScan(shop);

  return {
    shop, tab,
    downloads: { problems: signedSeoUrl(`export/problems/${shop}`), all: signedSeoUrl(`export/all/${shop}`) },
    q, f, rule, page, pages: Math.max(1, Math.ceil(total / PAGE)), total,
    stats: { products: all.length, avg, withErrors, warnOnly, clean, fixable },
    attention: batches.filter((b) => b.status === "applying" || isRunning(b.id)).length,
    rules: RULES.map((r) => ({ id: r.id, name: r.name, description: r.description, severity: r.severity, fixable: r.fixable, count: byRule.get(r.id) ?? 0 })).filter((r) => r.count > 0).sort((a, b) => b.count - a.count),
    rows: rows.map((r) => ({
      id: r.productId, title: r.title, handle: r.handle, vendor: r.vendor, thumb: r.thumb, seoTitle: r.seoTitle, seoDescription: r.seoDescription,
      score: r.score, errors: r.errors, warnings: r.warnings, issues: JSON.parse(r.issues || "[]") as Issue[], images: JSON.parse(r.images || "[]") as { id: string; alt: string; url: string }[],
    })),
    batches: batches.map((b) => {
      const n = (s: string) => counts.find((c) => c.batchId === b.id && c.status === s)?._count._all ?? 0;
      const [pending, applied, failed, restored] = [n("pending"), n("applied"), n("failed"), n("restored")];
      return { id: b.id, name: b.name, status: b.status, at: b.createdAt.toISOString(), pending, applied, failed, restored, total: pending + applied + failed + restored, running: isRunning(b.id) };
    }),
    scan: scan && { status: scan.status, fetched: scan.fetched, total: getTask(shop, "seoscan")?.total ?? 0, error: scan.error, at: (scan.finishedAt ?? scan.startedAt).toISOString() },
  };
};

type Json = Record<string, unknown>;
async function post<T = Json>(op: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`/api/seo/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(j.error ?? `Request failed (${res.status})`));
  return j as T;
}

const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
/** "5m ago" depends on the clock, so server and browser text can differ by a second: tell React not to complain. */
const Ago = ({ iso }: { iso: string }) => <span suppressHydrationWarning>{ago(iso)}</span>;
const FIELD = { seoTitle: "SEO title", seoDescription: "Meta description", alt: "Image ALT" } as const;

type Preview = { batchId: string | null; rows: number; unchanged: number; total: number; counts: { seoTitle: number; seoDescription: number; alt: number; warnings: number }; sample: Change[]; skipped: Skipped[]; skippedTotal: number };
type Progress = { status: string; total: number; pending: number; applied: number; failed: number; restored: number; running: boolean };

/** Starts/undoes a batch on the server and follows its progress. The work continues on the server if the page is closed. */
function useBatch(batchId: string, initial: Progress) {
  const rv = useRevalidator();
  const [progress, setProgress] = useState<Progress>(initial);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"apply" | "undo">("apply");
  const running = progress.running;

  useEffect(() => {
    if (!running) return;
    let stop = false;
    let failed = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await post<{ progress?: Progress }>("progress", { batchId });
        if (stop) return;
        if (!r.progress) throw new Error("The server sent an unexpected answer. Reload the page.");
        setProgress(r.progress);
        failed = 0;
        if (!r.progress.running) {
          rv.revalidate();
          return;
        }
      } catch (e) {
        if (!stop) setError((e as Error).message);
        failed += 1;
        if (failed >= 5) return; // give up after five failures in a row; the page can be reloaded
      }
      if (!stop) timer = setTimeout(tick, 900);
    };
    timer = setTimeout(tick, 400);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [running, batchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (op: "apply" | "undo") => {
    setError(null);
    setMode(op);
    try {
      const r = await post<{ progress?: Progress }>(op, { batchId });
      if (!r.progress) throw new Error("The server sent an unexpected answer. Reload the page.");
      setProgress({ ...r.progress, running: true });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const retry = async () => {
    setError(null);
    try {
      await post("retry", { batchId });
      await start("apply");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { progress, error, mode, start, retry };
}

function Bar({ p, mode }: { p: Progress; mode: "apply" | "undo" }) {
  const base = mode === "apply" ? p.total : p.restored + p.applied;
  const done = mode === "apply" ? p.applied + p.failed : p.restored;
  const pct = base ? Math.min(100, Math.round((done / base) * 100)) : 0;
  return (
    <div className="seo-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className={`seo-bar ${p.running ? "live" : ""}`}><i style={{ width: `${pct}%` }} /></div>
      <p>
        <b>{pct}%</b> · {done} of {base} {mode === "apply" ? "done" : "restored"}
        {mode === "apply" && <> · {p.applied} applied · {p.failed} failed · {p.pending} waiting</>}
      </p>
    </div>
  );
}

/** Everything about one batch: progress bar, and the buttons that make sense for its state. */
function BatchPanel({ batchId, initial, onDiscarded }: { batchId: string; initial: Progress; onDiscarded?: () => void }) {
  const rv = useRevalidator();
  const { progress: p, error, mode, start, retry } = useBatch(batchId, initial);
  const [confirm, setConfirm] = useState(false);
  const [failures, setFailures] = useState<{ productTitle: string; kind: keyof typeof FIELD; error: string }[]>([]);
  const fresh = p.applied + p.failed + p.restored === 0;
  const undone = p.status === "restored" || (p.restored > 0 && p.applied === 0 && p.pending === 0);

  useEffect(() => {
    if (p.running || p.failed === 0) {
      setFailures([]);
      return;
    }
    post<{ rows: typeof failures }>("failures", { batchId }).then((r) => setFailures(r.rows)).catch(() => undefined);
  }, [p.running, p.failed, batchId]);

  const discard = async () => {
    await post("discard", { batchId }).catch(() => undefined);
    rv.revalidate();
    onDiscarded?.();
  };

  return (
    <div className="seo-batchpanel">
      {error && <Banner tone="critical">{error}</Banner>}
      {(p.running || !fresh) && <Bar p={p} mode={undone || mode === "undo" ? "undo" : "apply"} />}
      {p.running && <p className="o-muted">Running on the server. You can leave this page; it keeps going.</p>}

      {!p.running && fresh && !undone && !confirm && (
        <div className="o-row">
          <button onClick={() => setConfirm(true)}>Apply {p.total} changes…</button>
          <button className="ghost" onClick={discard}>Discard</button>
        </div>
      )}
      {!p.running && fresh && confirm && (
        <Banner tone="warning">
          <b>Change {p.total} values in your live Shopify store?</b> Each old value is saved and you can undo the whole batch.
          <div className="o-row" style={{ marginTop: 8 }}>
            <button onClick={() => { setConfirm(false); void start("apply"); }}>Yes, apply now</button>
            <button className="ghost" onClick={() => setConfirm(false)}>Not yet</button>
          </div>
        </Banner>
      )}

      {!p.running && !fresh && p.pending > 0 && !undone && (
        <>
          <Banner tone="warning">Stopped with {p.pending} changes still waiting (the server was restarted or the connection was lost).</Banner>
          <div className="o-row">
            <button onClick={() => start("apply")}>Continue applying</button>
            {p.applied > 0 && <button className="danger" onClick={() => start("undo")}><Undo2 size={14} /> Undo the {p.applied} applied</button>}
          </div>
        </>
      )}

      {!p.running && !fresh && p.pending === 0 && (
        <>
          {p.failed > 0 && !undone && (
            <Banner tone="warning">
              {p.failed} change{p.failed > 1 ? "s" : ""} did not go through. Nothing was overwritten that you did not preview.
              <ul className="seo-fails">{failures.slice(0, 8).map((f, i) => <li key={i}><b>{f.productTitle}</b> · {FIELD[f.kind]}: {f.error}</li>)}</ul>
            </Banner>
          )}
          {undone && <Banner tone="info">This batch was undone. The old values are back in Shopify.</Banner>}
          {!undone && p.failed === 0 && p.applied > 0 && <Banner tone="success"><CheckCircle2 size={14} /> All {p.applied} changes are live in Shopify.</Banner>}
          <div className="o-row">
            {!undone && p.failed > 0 && <button className="ghost" onClick={retry}><RotateCcw size={14} /> Retry failed</button>}
            {!undone && p.applied > 0 && <button className="danger" onClick={() => start("undo")}><Undo2 size={14} /> Undo this batch</button>}
          </div>
        </>
      )}
    </div>
  );
}

function Importer({ ready }: { ready: boolean }) {
  const rv = useRevalidator();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [pv, setPv] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPv(null);
    if (input.current) input.current.value = "";
  };

  const pick = async (file: File) => {
    setError(null);
    setPv(null);
    if (!/\.csv$/i.test(file.name)) return setError("Please choose a .csv file.");
    if (file.size > 8_000_000) return setError("The file is larger than 8 MB. Split it into smaller files.");
    setName(file.name);
    setChecking(true);
    try {
      setPv(await post<Preview>("preview", { csv: await file.text(), name: file.name }));
      rv.revalidate();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="seo-import">
      {error && <Banner tone="critical">{error}</Banner>}
      {!pv && (
        <label className={`seo-drop ${ready && !checking ? "" : "off"}`}>
          <FileUp size={22} />
          <b>{checking ? `Checking ${name}…` : "Choose the filled CSV file"}</b>
          <span>Only the new_* columns are read. Nothing changes in Shopify yet: you see a preview first.</span>
          <input ref={input} type="file" accept=".csv,text/csv" disabled={!ready || checking} onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        </label>
      )}
      {checking && <ProgressBar label={`Checking ${name} against your products`} detail="Nothing is changed in Shopify yet." />}

      {pv && (
        <div className="seo-preview">
          <div className="seo-sum">
            <div><b>{pv.total}</b><span>changes ready</span></div>
            <div><b>{pv.counts.seoTitle}</b><span>SEO titles</span></div>
            <div><b>{pv.counts.seoDescription}</b><span>meta descriptions</span></div>
            <div><b>{pv.counts.alt}</b><span>image ALT texts</span></div>
            <div className={pv.skippedTotal ? "warn" : ""}><b>{pv.skippedTotal}</b><span>rows skipped</span></div>
          </div>
          {pv.unchanged > 0 && <p className="o-muted">{pv.unchanged} value{pv.unchanged > 1 ? "s were" : " was"} the same as now and will be left alone.</p>}
          {pv.counts.warnings > 0 && <p className="o-muted">{pv.counts.warnings} change{pv.counts.warnings > 1 ? "s are" : " is"} outside the usual length advice. They are still allowed.</p>}

          {pv.total === 0 ? (
            <>
              <Banner tone="warning">Nothing to change. Fill the new_seo_title, new_seo_description or new_alt columns and upload again.</Banner>
              <button className="ghost" onClick={reset}>Choose another file</button>
            </>
          ) : (
            <div className="seo-table">
              <table>
                <thead><tr><th>Product</th><th>What</th><th>Now</th><th>New</th></tr></thead>
                <tbody>
                  {pv.sample.map((c, i) => (
                    <tr key={i}>
                      <td>{c.productTitle}</td>
                      <td><Badge>{FIELD[c.kind]}</Badge></td>
                      <td className="seo-before">{c.before || <em>not set</em>}</td>
                      <td className="seo-after">{c.after}{c.warn && <small className="seo-warn"> · {c.warn}</small>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pv.total > pv.sample.length && <p className="o-muted">Showing the first {pv.sample.length} of {pv.total} changes. All of them are applied.</p>}
            </div>
          )}

          {pv.skippedTotal > 0 && (
            <details className="seo-skipped">
              <summary>{pv.skippedTotal} row{pv.skippedTotal > 1 ? "s" : ""} will be skipped. Why?</summary>
              <ul>{pv.skipped.map((s, i) => <li key={i}><b>Line {s.line}</b> {s.reason}</li>)}</ul>
              {pv.skippedTotal > pv.skipped.length && <p className="o-muted">…and {pv.skippedTotal - pv.skipped.length} more.</p>}
            </details>
          )}

          {pv.batchId && pv.total > 0 && (
            <>
              <BatchPanel batchId={pv.batchId} initial={{ status: "preview", total: pv.total, pending: pv.total, applied: 0, failed: 0, restored: 0, running: false }} onDiscarded={reset} />
              <button className="ghost" onClick={reset}>Choose another file</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- look and feel helpers ----------

const SHORT: Record<string, string> = {
  "seo-title-missing": "No SEO title", "seo-title-short": "Short title", "seo-title-long": "Long title",
  "seo-desc-missing": "No meta description", "seo-desc-short": "Short description", "seo-desc-long": "Long description",
  "title-duplicate": "Duplicate title", "desc-duplicate": "Duplicate description",
  "description-missing": "No product text", "description-thin": "Thin product text", "images-none": "No image",
  "alt-missing": "Missing ALT", "alt-duplicate": "Repeated ALT", "handle-poor": "Untidy URL",
};
const sev = (s: string) => (s === "critical" || s === "high" ? "bad" : s === "medium" ? "warn" : "low");
const level = (score: number) => (score >= 85 ? "good" : score >= 60 ? "mid" : "bad");
const grade = (score: number) => (score >= 85 ? "Healthy" : score >= 60 ? "Needs work" : "Needs attention");

/** Round score gauge. The ring animates in once when the page opens. */
function ScoreRing({ value, size = 150, compact = false }: { value: number; size?: number; compact?: boolean }) {
  const R = 42;
  const C = 2 * Math.PI * R;
  const dash = (Math.max(0, Math.min(100, value)) / 100) * C;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`seo-ring ${level(value)}`} role="img" aria-label={`Score ${value} out of 100`}>
      <circle className="seo-ring-bg" cx="50" cy="50" r={R} fill="none" strokeWidth={compact ? 10 : 8} />
      <circle className="seo-ring-fg" cx="50" cy="50" r={R} fill="none" strokeWidth={compact ? 10 : 8} strokeLinecap="round" strokeDasharray={`${dash} ${C}`} transform="rotate(-90 50 50)" />
      <text x="50" y={compact ? 58 : 53} textAnchor="middle" className="seo-ring-num" fontSize={compact ? 30 : 30}>{value}</text>
      {!compact && <text x="50" y="68" textAnchor="middle" className="seo-ring-sub" fontSize="8">out of 100</text>}
    </svg>
  );
}

/** A length bar with the usual good range marked, so "too short / too long" is visible at a glance. */
function Meter({ label, len, min, max, cap }: { label: string; len: number; min: number; max: number; cap: number }) {
  const state = len === 0 ? "none" : len < min ? "short" : len > max ? "long" : "good";
  return (
    <div className="seo-meter">
      <div className="seo-meter-top">
        <span>{label}</span>
        <b className={state}>{len === 0 ? "not set" : `${len} characters · ${state === "good" ? "good length" : state === "short" ? "a bit short" : "a bit long"}`}</b>
      </div>
      <div className="seo-meter-track">
        <i className="band" style={{ left: `${(min / cap) * 100}%`, width: `${((max - min) / cap) * 100}%` }} />
        <i className={`fill ${state}`} style={{ width: `${Math.min(100, (len / cap) * 100)}%` }} />
      </div>
      <small>Usual range {min}–{max}</small>
    </div>
  );
}

/** How the product could look in a search result (a preview of the stored text, not a promise of what Google shows). */
function Serp({ title, description, handle, shop }: { title: string; description: string; handle: string; shop: string }) {
  return (
    <div className="seo-serp" aria-label="Search result preview">
      <div className="seo-serp-url">
        <span className="seo-fav">{shop.charAt(0).toUpperCase()}</span>
        <span>{shop}<em> › products › {handle}</em></span>
      </div>
      <div className="seo-serp-title">{title}</div>
      <div className="seo-serp-desc">{description || <em>No meta description. Search engines will pick some text from the page.</em>}</div>
    </div>
  );
}

export default function Seo() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator();
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = d.scan?.status === "running";
  const scanned = d.stats.products > 0;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => rv.revalidate(), 2000);
    return () => clearInterval(t);
  }, [running, rv]);

  const scan = async () => {
    setErr(null);
    setStarting(true);
    try {
      await post("scan");
      rv.revalidate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const qs = (o: Record<string, string>) => {
    const p = new URLSearchParams({ tab: d.tab, q: d.q, f: d.f, rule: d.rule, ...o });
    for (const [k, v] of [...p]) if (!v || (k === "f" && v === "all") || (k === "page" && v === "1")) p.delete(k);
    return `?${p.toString()}`;
  };
  const maxRule = Math.max(1, ...d.rules.map((r) => r.count));
  const wins = d.rules.filter((r) => r.fixable === "csv").slice(0, 3);
  const manual = d.rules.filter((r) => r.fixable === "manual");
  const pct = (n: number) => (d.stats.products ? (n / d.stats.products) * 100 : 0);
  const counts: Record<string, number> = { all: d.stats.products, errors: d.stats.withErrors, warn: d.stats.warnOnly, clean: d.stats.clean };

  return (
    <Page
      title="SEO"
      subtitle="A fixed checklist for your products, with bulk fixes you control. No AI runs inside this app."
      actions={
        <button onClick={scan} disabled={starting || running}>
          <ScanSearch size={15} /> {running ? `Scanning… ${d.scan?.fetched ?? 0} products` : scanned ? "Scan again" : "Scan my store"}
        </button>
      }
    >
      {err && <Banner tone="critical">{err}</Banner>}
      {d.scan?.status === "error" && <Banner tone="critical">The last scan failed: {d.scan.error}</Banner>}
      {running && (
        <div className="pbar-box" aria-live="polite">
          <ProgressBar label="Reading and checking your products" done={d.scan?.fetched ?? 0} total={d.scan?.total || null} detail="You can leave this page; the scan keeps going." />
        </div>
      )}

      <nav className="seo-tabs" aria-label="SEO sections">
        {TABS.map(([k, label]) => (
          <Link key={k} to={`?tab=${k}`} className={d.tab === k ? "on" : ""} preventScrollReset>
            {label}
            {k === "products" && scanned && <span className="seo-tab-n">{d.stats.products.toLocaleString()}</span>}
            {k === "fix" && d.attention > 0 && <span className="seo-tab-dot" title="A batch needs your attention" />}
          </Link>
        ))}
      </nav>

      {/* ---------------- Overview ---------------- */}
      {d.tab === "overview" && (
        <>
          {!scanned ? (
            <section className="seo-empty">
              <span className="seo-empty-ico"><ScanSearch size={26} /></span>
              <h2>{running ? "Reading your products…" : "Let’s check your store"}</h2>
              <p>{running ? `${d.scan?.fetched ?? 0} products read so far.` : "The app reads every product (title, SEO title, meta description, image ALT text) and checks it against the SEO checklist. Nothing is changed."}</p>
              {!running && <button onClick={scan} disabled={starting}><ScanSearch size={15} /> Scan my store</button>}
            </section>
          ) : (
            <>
              <section className="seo-hero">
                <div className="seo-hero-ring">
                  <ScoreRing value={d.stats.avg} />
                  <span className={`seo-grade ${level(d.stats.avg)}`}>{grade(d.stats.avg)}</span>
                </div>
                <div className="seo-hero-main">
                  <h2>Checklist score</h2>
                  <p>On average your products pass {d.stats.avg}% of the checks below. This is a checklist result, not a Google ranking.</p>
                  <div className="seo-dist" role="img" aria-label={`${d.stats.clean} clean, ${d.stats.warnOnly} with warnings, ${d.stats.withErrors} with errors`}>
                    <i className="clean" style={{ width: `${pct(d.stats.clean)}%` }} />
                    <i className="warn" style={{ width: `${pct(d.stats.warnOnly)}%` }} />
                    <i className="bad" style={{ width: `${pct(d.stats.withErrors)}%` }} />
                  </div>
                  <ul className="seo-dist-keys">
                    <li><Link to={qs({ tab: "products", f: "clean", rule: "", q: "", page: "1" })}><i className="clean" />No issues <b>{d.stats.clean}</b></Link></li>
                    <li><Link to={qs({ tab: "products", f: "warn", rule: "", q: "", page: "1" })}><i className="warn" />Warnings only <b>{d.stats.warnOnly}</b></Link></li>
                    <li><Link to={qs({ tab: "products", f: "errors", rule: "", q: "", page: "1" })}><i className="bad" />With errors <b>{d.stats.withErrors}</b></Link></li>
                  </ul>
                </div>
                <dl className="seo-hero-stats">
                  <div><dt>Products checked</dt><dd>{d.stats.products.toLocaleString()}</dd></div>
                  <div><dt>Fixable with CSV</dt><dd>{d.stats.fixable.toLocaleString()}</dd></div>
                  <div><dt>Last scan</dt><dd className="small">{d.scan ? <Ago iso={d.scan.at} /> : "never"}</dd></div>
                </dl>
              </section>

              {wins.length > 0 && (
                <section aria-label="Quick wins">
                  <div className="seo-sec-head"><h3>Quick wins</h3><span>The biggest problems you can fix in bulk with a CSV file</span></div>
                  <div className="seo-wins">
                    {wins.map((r, i) => (
                      <Link key={r.id} to="?tab=fix" className="seo-win" preventScrollReset>
                        <span className="seo-win-n">{i + 1}</span>
                        <span className="seo-win-main"><b>{r.name}</b><small>{r.count} product{r.count > 1 ? "s" : ""}</small></span>
                        <ArrowRight size={16} />
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              <Card title="All problems found" action={<span className="o-muted">Click one to see the products</span>}>
                {d.rules.length === 0 ? (
                  <p className="seo-allgood"><CheckCircle2 size={18} /> Every product passes every check. Nothing to fix.</p>
                ) : (
                  <ul className="seo-rules">
                    {d.rules.map((r) => (
                      <li key={r.id}>
                        <Link to={qs({ tab: "products", rule: r.id, f: "all", q: "", page: "1" })} title={r.description}>
                          <span className={`seo-sev ${sev(r.severity)}`} aria-hidden="true" />
                          <span className="seo-rule-name">
                            <b>{r.name}</b>
                            <small>{r.severity} · {r.fixable === "csv" ? "fix with CSV" : "fix in Shopify"}</small>
                          </span>
                          <span className="seo-rule-bar"><i className={sev(r.severity)} style={{ width: `${Math.round((r.count / maxRule) * 100)}%` }} /></span>
                          <b className="seo-rule-count">{r.count}</b>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {manual.length > 0 && <p className="seo-foot">Problems marked “fix in Shopify” (product text, photos, URL) need a person; the CSV cannot change them.</p>}
              </Card>
            </>
          )}
        </>
      )}

      {/* ---------------- Products ---------------- */}
      {d.tab === "products" && (
        <Card>
          <div className="seo-toolbar">
            <Form method="get" className="seo-search" role="search">
              <input type="hidden" name="tab" value="products" />
              {d.f !== "all" && <input type="hidden" name="f" value={d.f} />}
              {d.rule && <input type="hidden" name="rule" value={d.rule} />}
              <Search size={15} />
              <input name="q" defaultValue={d.q} placeholder="Search by name, handle or brand" aria-label="Search products" />
            </Form>
            <div className="seo-pills" role="group" aria-label="Filter">
              {FILTERS.map(([k, l]) => (
                <Link key={k} to={qs({ tab: "products", f: k, page: "1" })} className={d.f === k ? "on" : ""} preventScrollReset>
                  {l}<span>{counts[k]}</span>
                </Link>
              ))}
            </div>
          </div>
          {(d.rule || d.q) && (
            <div className="seo-active">
              {d.rule && <Link to={qs({ rule: "", page: "1" })} className="seo-chip">{ruleById(d.rule)?.name} <X size={12} /></Link>}
              {d.q && <Link to={qs({ q: "", page: "1" })} className="seo-chip">“{d.q}” <X size={12} /></Link>}
              <span className="o-muted">{d.total.toLocaleString()} product{d.total === 1 ? "" : "s"}</span>
            </div>
          )}

          {d.rows.length === 0 ? (
            <p className="seo-none">{scanned ? "No products match these filters." : "Scan your store first to see products here."}</p>
          ) : (
            <ul className="seo-list">
              {d.rows.map((p) => (
                <li key={p.id}>
                  <details>
                    <summary>
                      {p.thumb ? <img src={p.thumb} alt="" width={44} height={44} loading="lazy" /> : <span className="seo-nothumb"><ImageOff size={16} /></span>}
                      <span className="seo-main">
                        <b>{p.title}</b>
                        <small>{p.vendor ? `${p.vendor} · ` : ""}/products/{p.handle}</small>
                        {p.issues.length > 0 && (
                          <span className="seo-chips">
                            {p.issues.slice(0, 3).map((i) => <span key={i.rule} className={`seo-tag ${sev(i.severity)}`}>{SHORT[i.rule] ?? i.rule}</span>)}
                            {p.issues.length > 3 && <span className="seo-tag more">+{p.issues.length - 3}</span>}
                          </span>
                        )}
                      </span>
                      <ScoreRing value={p.score} size={46} compact />
                      <ChevronDown size={16} className="seo-caret" />
                    </summary>
                    <div className="seo-detail">
                      <div className="seo-detail-left">
                        <Serp title={p.seoTitle || p.title} description={p.seoDescription} handle={p.handle} shop={d.shop} />
                        <Meter label="SEO title" len={p.seoTitle.length} min={30} max={60} cap={80} />
                        <Meter label="Meta description" len={p.seoDescription.length} min={70} max={160} cap={200} />
                      </div>
                      <div className="seo-detail-right">
                        <h4>{p.issues.length ? `What to improve (${p.issues.length})` : "Nothing to improve"}</h4>
                        {p.issues.length === 0 ? (
                          <p className="seo-allgood"><CheckCircle2 size={16} /> This product passes every check.</p>
                        ) : (
                          <ul className="seo-issues">
                            {p.issues.map((i, k) => (
                              <li key={k}>
                                <span className={`seo-sev ${sev(i.severity)}`} aria-hidden="true" />
                                <span><b>{i.message}</b><small>{i.fix}</small></span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      {p.images.length > 0 && (
                        <div className="seo-detail-wide">
                          <h4>Images and ALT text</h4>
                          <ul className="seo-alts">
                            {p.images.slice(0, 12).map((im) => (
                              <li key={im.id} className={im.alt ? "" : "missing"}>
                                {im.url ? <img src={im.url} alt="" width={44} height={44} loading="lazy" /> : <span className="seo-nothumb" />}
                                <span>{im.alt || "No ALT text"}</span>
                              </li>
                            ))}
                          </ul>
                          {p.images.length > 12 && <small className="o-muted">…and {p.images.length - 12} more images.</small>}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {d.pages > 1 && (
            <div className="seo-pager">
              {d.page > 1 ? <Link to={qs({ page: String(d.page - 1) })} preventScrollReset>← Previous</Link> : <span />}
              <small>Page {d.page} of {d.pages}</small>
              {d.page < d.pages ? <Link to={qs({ page: String(d.page + 1) })} preventScrollReset>Next →</Link> : <span />}
            </div>
          )}
        </Card>
      )}

      {/* ---------------- Bulk fix ---------------- */}
      {d.tab === "fix" && (
        <>
          <ol className="seo-flow">
            <li>
              <span className="seo-step-n">1</span>
              <div>
                <h3>Download</h3>
                <p>Each product with its problems, plus its name, brand and type so a writer (or any tool you use) knows what it is.</p>
                <div className="o-row">
                  <a className="seo-dl" href={d.downloads.problems} download aria-disabled={!scanned}><Download size={14} /> Products with problems</a>
                  <a className="seo-dl alt" href={d.downloads.all} download aria-disabled={!scanned}>All products</a>
                </div>
              </div>
            </li>
            <li>
              <span className="seo-step-n">2</span>
              <div>
                <h3>Fill the new columns</h3>
                <p>Write the new SEO title, meta description and image ALT text outside this app. Do not change the id columns. An empty cell keeps the old value.</p>
                <ul className="seo-cols">
                  <li><code>new_seo_title</code></li>
                  <li><code>new_seo_description</code></li>
                  <li><code>new_alt</code></li>
                </ul>
              </div>
            </li>
            <li>
              <span className="seo-step-n">3</span>
              <div>
                <h3>Upload, preview, apply</h3>
                <p>You see every before/after change and every refused row first. Only after you confirm does anything change in Shopify, and every batch can be undone.</p>
              </div>
            </li>
          </ol>

          <Card title="Upload the filled file">
            <Importer ready={scanned} />
          </Card>

          {d.batches.length > 0 && (
            <Card title="History">
              <ul className="seo-batches">
                {d.batches.map((b) => (
                  <li key={b.id}>
                    <div className="seo-batch-head">
                      <span><b>{b.name}</b><small><Ago iso={b.at} /> · {b.total} changes</small></span>
                      <Badge tone={b.status === "done" ? "success" : b.status === "restored" ? "info" : "warning"}>{b.status === "preview" ? "not applied" : b.status === "applying" ? (b.running ? "applying…" : "partly applied") : b.status}</Badge>
                    </div>
                    <BatchPanel batchId={b.id} initial={{ status: b.status, total: b.total, pending: b.pending, applied: b.applied, failed: b.failed, restored: b.restored, running: b.running }} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <p className="seo-disclaimer">
        The score only counts checklist items a product passes (title and description present, sensible length, ALT text, no duplicates). It does not predict Google rankings.
        The length ranges (SEO title 30–60, description 70–160 characters) are common guidance, not rules set by Google.
      </p>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
