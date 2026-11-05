import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logEvent } from "../lib/log.server";
import { rateLimited } from "../lib/rate-limit.server";
import { shopifyCtx } from "../lib/image/shopify-ctx.server";
import { verifySeoSignature } from "../lib/media.server";
import { CsvError } from "../lib/seo/csv";
import { batchProgress, discardBatch, exportCsv, latestScan, previewCsv, retryFailed, startRun, startScan } from "../lib/seo/seo-store.server";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * GET /api/seo/export/<problems|all>/<shop>?exp=&sig= : the CSV to fill in.
 * A normal link inside the embedded admin carries no login, so the link is signed (like the other downloads) instead.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const parts = (params["*"] ?? "").split("/").map(decodeURIComponent);
  const [kind, scope, shop] = parts;
  if (kind !== "export" || parts.length !== 3 || (scope !== "problems" && scope !== "all") || !shop) return new Response("Not found", { status: 404 });
  if (!verifySeoSignature(parts.join("/"), url.searchParams.get("exp"), url.searchParams.get("sig"))) return new Response("This download link has expired. Reload the SEO page and try again.", { status: 403 });
  const out = await exportCsv(shop, { onlyProblems: scope === "problems" });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(out.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="seo-fixes-${scope}-${day}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

const id = (v: unknown) => (typeof v === "string" && /^[\w-]{8,64}$/.test(v) ? v : null);

/** POST /api/seo/<op> with a JSON body. Every op works on the signed-in shop only. */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const op = params["*"];
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (rateLimited(`seo:${shop}`, 600, 60_000)) return json({ error: "Too many requests, slow down." }, 429);

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* ops without a body */
  }
  const ctx = shopifyCtx(shop);

  try {
    if (op === "scan") {
      const s = await startScan(shop, ctx);
      if (!s.already) await logEvent({ shop, source: "admin", event: "seo_scan_started", detail: "Store scan started" });
      return json({ ok: true, id: s.id, already: s.already });
    }
    if (op === "scan-status") {
      const s = await latestScan(shop);
      return json({ scan: s && { id: s.id, status: s.status, fetched: s.fetched, error: s.error } });
    }
    if (op === "preview") {
      const csv = typeof body.csv === "string" ? body.csv : "";
      if (!csv.trim()) return json({ error: "The file is empty." }, 400);
      const name = typeof body.name === "string" ? body.name : "CSV upload";
      const r = await previewCsv(shop, csv, name);
      await logEvent({ shop, source: "admin", event: "seo_csv_checked", detail: `${name}: ${r.total} changes, ${r.skippedTotal} skipped` });
      return json({ ok: true, ...r });
    }
    const batchId = id(body.batchId);
    if (!batchId) return json({ error: "Missing batch." }, 400);
    if (op === "apply" || op === "undo") {
      // runs in the background on the server; the page only watches /progress
      const run = await startRun(shop, ctx, batchId, op);
      if (run.started) {
        void run.done
          .then(async () => {
            const p = await batchProgress(shop, batchId);
            await logEvent({ shop, source: "admin", level: p?.failed ? "error" : "info", event: op === "apply" ? "seo_applied" : "seo_undone", detail: `${p?.applied ?? 0} applied, ${p?.restored ?? 0} restored, ${p?.failed ?? 0} failed` });
          })
          .catch((e) => logEvent({ shop, source: "admin", level: "error", event: "seo_failed", detail: `${op}: ${String((e as Error)?.message ?? e).slice(0, 200)}` }));
      }
      return json({ ok: true, started: run.started, progress: await batchProgress(shop, batchId) });
    }
    if (op === "progress") {
      const p = await batchProgress(shop, batchId);
      return p ? json({ ok: true, progress: p }) : json({ error: "Batch not found." }, 404);
    }
    if (op === "retry") {
      await retryFailed(shop, batchId);
      return json({ ok: true });
    }
    if (op === "discard") {
      await discardBatch(shop, batchId);
      return json({ ok: true });
    }
    if (op === "failures") {
      const rows = await prisma.seoChange.findMany({ where: { batchId, shop, status: "failed" }, take: 200, select: { productTitle: true, kind: true, error: true } });
      return json({ ok: true, rows });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof CsvError) return json({ error: e.message }, 400);
    await logEvent({ shop, source: "admin", level: "error", event: "seo_failed", detail: `${op}: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
    return json({ error: String((e as Error)?.message ?? "Something went wrong.") }, 500);
  }
};
