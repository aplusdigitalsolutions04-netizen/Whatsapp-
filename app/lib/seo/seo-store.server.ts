// SEO feature, database side: scan the store, audit it, export the CSV, check an uploaded CSV, apply it to Shopify and undo it.
// No login code in here (the Shopify connection is passed in), so it can be tested with a fake Shopify.
import { randomUUID } from "node:crypto";
import prisma from "../../db.server.ts";
import type { Ctx } from "../image/shopify-images.server.ts";
import { cleanText, CsvError, parseCsv, planChanges, toCsv, COLUMNS, type Change, type LiveProduct, type Skipped } from "./csv.ts";
import { altProblemImages, auditProduct, duplicateIndex, ruleById, type Issue, type SeoImage, type SeoProduct } from "./rules.ts";
import { endTask, startTask, updateTask } from "../progress.server.ts";
import { countProducts, fetchProductsPage, liveAlts, liveSeo, setAlt, setAlts, setProductSeo } from "./shopify-seo.server.ts";

const MAX_CSV_CHARS = 8_000_000;
const MAX_ROWS = 50_000;
const MAX_PAGES = 2_000;

type Row = NonNullable<Awaited<ReturnType<typeof prisma.seoProduct.findFirst>>>;

const parse = <T,>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const toRules = (r: Row): SeoProduct => ({
  id: r.productId, title: r.title, handle: r.handle, vendor: r.vendor, productType: r.productType,
  tags: r.tags ? r.tags.split(", ") : [], status: r.status, descText: r.descText, seoTitle: r.seoTitle, seoDescription: r.seoDescription,
  images: parse<SeoImage[]>(r.images, []),
});

// ---------- scan ----------

const running = new Map<string, string>(); // shop -> scan id

/** Re-checks every stored product against the rules (needed after a scan or after changes are applied: duplicates depend on all products). */
export async function reaudit(shop: string) {
  const rows = await prisma.seoProduct.findMany({ where: { shop } });
  const dups = duplicateIndex(rows.map(toRules));
  for (let i = 0; i < rows.length; i += 100) {
    await prisma.$transaction(
      rows.slice(i, i + 100).map((r) => {
        const a = auditProduct(toRules(r), dups);
        return prisma.seoProduct.update({
          where: { id: r.id },
          data: { issues: JSON.stringify(a.issues.map(({ rule, severity, message, fix }) => ({ rule, severity, message, fix }))), score: a.score, errors: a.errors, warnings: a.warnings },
        });
      }),
    );
  }
}

/** Reads every product from Shopify (page by page) and re-checks them. Awaitable so tests can wait for it. */
export async function runScan(shop: string, ctx: Ctx, scanId: string) {
  const started = new Date();
  try {
    startTask(shop, "seoscan", "Reading and checking your products", (await countProducts(ctx)) || null);
    let after: string | null = null;
    let n = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchProductsPage(ctx, after);
      await prisma.$transaction(
        res.products.map((p) => {
          const data = {
            title: p.title, handle: p.handle, vendor: p.vendor, productType: p.productType, tags: p.tags.join(", "), status: p.status,
            descText: p.descText.slice(0, 2000), seoTitle: p.seoTitle, seoDescription: p.seoDescription, thumb: p.thumb,
            images: JSON.stringify(p.images), scannedAt: new Date(),
          };
          return prisma.seoProduct.upsert({ where: { shop_productId: { shop, productId: p.id } }, create: { shop, productId: p.id, ...data }, update: data });
        }),
      );
      n += res.products.length;
      updateTask(shop, "seoscan", { done: n });
      await prisma.seoScan.update({ where: { id: scanId }, data: { fetched: n } });
      if (!res.hasNext || !res.endCursor) break;
      after = res.endCursor;
    }
    await prisma.seoProduct.deleteMany({ where: { shop, scannedAt: { lt: started } } }); // products that no longer exist
    await reaudit(shop);
    await prisma.seoScan.update({ where: { id: scanId }, data: { status: "done", finishedAt: new Date() } });
    endTask(shop, "seoscan");
  } catch (e) {
    endTask(shop, "seoscan", String((e as Error)?.message ?? e).slice(0, 200));
    await prisma.seoScan.update({ where: { id: scanId }, data: { status: "error", error: String((e as Error)?.message ?? e).slice(0, 300), finishedAt: new Date() } });
  } finally {
    running.delete(shop);
  }
}

/** Starts a scan in the background. Only one scan per shop at a time. */
export async function startScan(shop: string, ctx: Ctx): Promise<{ id: string; already: boolean; done: Promise<void> }> {
  const existing = running.get(shop);
  if (existing) return { id: existing, already: true, done: Promise.resolve() };
  const id = randomUUID();
  running.set(shop, id);
  await prisma.seoScan.create({ data: { id, shop } });
  return { id, already: false, done: runScan(shop, ctx, id) };
}

/** A scan marked "running" that no process is working on (the server restarted) is shown as interrupted. */
export async function latestScan(shop: string) {
  const s = await prisma.seoScan.findFirst({ where: { shop }, orderBy: { startedAt: "desc" } });
  if (s && s.status === "running" && running.get(shop) !== s.id) {
    return prisma.seoScan.update({ where: { id: s.id }, data: { status: "error", error: "The scan was interrupted (the server restarted). Start it again.", finishedAt: new Date() } });
  }
  return s;
}

// ---------- CSV export ----------

const FIXABLE_BY_CSV = (i: Issue) => ruleById(i.rule)?.fixable === "csv";

export async function exportCsv(shop: string, opts: { onlyProblems?: boolean } = {}): Promise<{ csv: string; products: number; images: number }> {
  const rows = await prisma.seoProduct.findMany({ where: { shop }, orderBy: [{ score: "asc" }, { title: "asc" }] });
  const out: string[][] = [[...COLUMNS]];
  let products = 0;
  let images = 0;
  for (const r of rows) {
    const issues = parse<Issue[]>(r.issues, []);
    const fixable = issues.filter(FIXABLE_BY_CSV);
    if ((opts.onlyProblems ?? true) && fixable.length === 0) continue;
    const p = toRules(r);
    const blank = (n: number) => Array<string>(n).fill("");
    // columns: type,id,product_id,handle,title,vendor,product_type,tags,description,problems,cur_t,new_t,cur_d,new_d,cur_alt,new_alt,image_url
    out.push(["product", r.productId, r.productId, r.handle, r.title, r.vendor, r.productType, p.tags.join(", "), r.descText.slice(0, 400), issues.map((i) => i.message).join(" | "),
      r.seoTitle, "", r.seoDescription, "", ...blank(3)]);
    products++;
    if (issues.some((i) => i.rule === "alt-missing" || i.rule === "alt-duplicate")) {
      for (const img of altProblemImages(p)) {
        out.push(["image", img.id, r.productId, r.handle, r.title, r.vendor, r.productType, "", "", img.alt ? "ALT text is used on more than one image" : "ALT text missing", "", "", "", "", img.alt, "", img.url]);
        images++;
      }
    }
  }
  return { csv: toCsv(out), products, images };
}

// ---------- check an uploaded CSV ----------

export type PreviewResult = {
  batchId: string | null;
  rows: number;
  unchanged: number;
  total: number;
  counts: { seoTitle: number; seoDescription: number; alt: number; warnings: number };
  sample: Change[];
  skipped: Skipped[];
  skippedTotal: number;
};

export async function previewCsv(shop: string, text: string, name: string): Promise<PreviewResult> {
  if (text.length > MAX_CSV_CHARS) throw new CsvError("The file is larger than 8 MB. Split it into smaller files.");
  const table = parseCsv(text);
  if (table.length > MAX_ROWS + 1) throw new CsvError(`The file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  const stored = await prisma.seoProduct.findMany({ where: { shop } });
  if (stored.length === 0) throw new CsvError("Scan the store first.");
  const live = new Map<string, LiveProduct>(
    stored.map((r) => [r.productId, { id: r.productId, title: r.title, seoTitle: r.seoTitle, seoDescription: r.seoDescription, images: new Map(parse<SeoImage[]>(r.images, []).map((i) => [i.id, i.alt])) }]),
  );
  const plan = planChanges(table, live);
  const counts = {
    seoTitle: plan.changes.filter((c) => c.kind === "seoTitle").length,
    seoDescription: plan.changes.filter((c) => c.kind === "seoDescription").length,
    alt: plan.changes.filter((c) => c.kind === "alt").length,
    warnings: plan.changes.filter((c) => c.warn).length,
  };
  let batchId: string | null = null;
  if (plan.changes.length) {
    batchId = randomUUID();
    await prisma.seoBatch.create({ data: { id: batchId, shop, name: name.slice(0, 120) || "CSV upload" } });
    for (let i = 0; i < plan.changes.length; i += 500) {
      await prisma.seoChange.createMany({
        data: plan.changes.slice(i, i + 500).map((c) => ({ batchId: batchId!, shop, kind: c.kind, productId: c.productId, productTitle: c.productTitle, mediaId: c.mediaId, before: c.before, after: c.after, warn: c.warn })),
      });
    }
  }
  return { batchId, rows: plan.rows, unchanged: plan.unchanged, total: plan.changes.length, counts, sample: plan.changes.slice(0, 300), skipped: plan.skipped.slice(0, 200), skippedTotal: plan.skipped.length };
}

// ---------- apply and undo ----------

export type Progress = { status: string; total: number; pending: number; applied: number; failed: number; restored: number; running: boolean };

const busy = new Set<string>();
/** batches that are being applied or undone by this server right now */
const runs = new Set<string>();

export async function batchProgress(shop: string, batchId: string): Promise<Progress | null> {
  const b = await prisma.seoBatch.findFirst({ where: { id: batchId, shop } });
  if (!b) return null;
  const g = await prisma.seoChange.groupBy({ by: ["status"], where: { batchId }, _count: { _all: true } });
  const n = (s: string) => g.find((x) => x.status === s)?._count._all ?? 0;
  const [pending, applied, failed, restored] = [n("pending"), n("applied"), n("failed"), n("restored")];
  return { status: b.status, total: pending + applied + failed + restored, pending, applied, failed, restored, running: runs.has(batchId) };
}

type Dir = "apply" | "undo";
type ChangeRow = NonNullable<Awaited<ReturnType<typeof prisma.seoChange.findFirst>>>;

const fail = (id: string, error: string) => prisma.seoChange.update({ where: { id }, data: { status: "failed", error: error.slice(0, 300) } });
const done = (id: string, status: string) => prisma.seoChange.update({ where: { id }, data: { status, error: null, appliedAt: new Date() } });

/** What Shopify must show right now for a change to be safe to write: the old value when applying, the new value when undoing. */
const expected = (c: ChangeRow, dir: Dir) => (dir === "apply" ? c.before : c.after);
const target = (c: ChangeRow, dir: Dir) => (dir === "apply" ? c.after : c.before);

async function patchSnapshot(shop: string, c: ChangeRow, value: string) {
  const row = await prisma.seoProduct.findUnique({ where: { shop_productId: { shop, productId: c.productId } } });
  if (!row) return;
  if (c.kind === "seoTitle") await prisma.seoProduct.update({ where: { id: row.id }, data: { seoTitle: value } });
  else if (c.kind === "seoDescription") await prisma.seoProduct.update({ where: { id: row.id }, data: { seoDescription: value } });
  else if (c.mediaId) {
    const imgs = parse<SeoImage[]>(row.images, []).map((i) => (i.id === c.mediaId ? { ...i, alt: value } : i));
    await prisma.seoProduct.update({ where: { id: row.id }, data: { images: JSON.stringify(imgs) } });
  }
}

/** Processes the next few changes of a batch. The page calls this again and again (showing a progress bar) until nothing is pending. */
async function step(shop: string, ctx: Ctx, batchId: string, dir: Dir, limit: number): Promise<Progress> {
  const from = dir === "apply" ? "pending" : "applied";
  const to = dir === "apply" ? "applied" : "restored";
  const batch = await prisma.seoBatch.findFirst({ where: { id: batchId, shop } });
  if (!batch) throw new Error("Batch not found.");
  if (dir === "apply" && !["preview", "applying", "done"].includes(batch.status)) throw new Error("This batch was already undone.");
  if (busy.has(batchId)) return (await batchProgress(shop, batchId))!;
  busy.add(batchId);
  try {
    if (dir === "apply" && batch.status === "preview") await prisma.seoBatch.update({ where: { id: batchId }, data: { status: "applying" } });
    const todo = await prisma.seoChange.findMany({ where: { batchId, status: from }, orderBy: [{ productId: "asc" }, { id: "asc" }], take: Math.max(1, Math.min(100, limit)) });

    const seo = new Map<string, ChangeRow[]>();
    for (const c of todo) {
      if (c.kind !== "alt") seo.set(c.productId, [...(seo.get(c.productId) ?? []), c]);
    }

    // ALT texts: read all current values in one request, check each, write the good ones in one request
    for (const c of todo) if (c.kind === "alt" && !c.mediaId) await fail(c.id, "The image id is missing.");
    const alts = todo.filter((c) => c.kind === "alt" && c.mediaId);
    if (alts.length) {
      try {
        const current = await liveAlts(ctx, alts.map((c) => c.mediaId!));
        const good: ChangeRow[] = [];
        for (const c of alts) {
          const cur = current.get(c.mediaId!);
          if (cur === undefined) await fail(c.id, "The image no longer exists in Shopify.");
          else if (cleanText(cur) !== cleanText(expected(c, dir))) await fail(c.id, dir === "apply" ? "The ALT text was changed in Shopify after the preview. Nothing was overwritten." : "The ALT text was changed again after it was applied. Not restored.");
          else good.push(c);
        }
        const finish = async (c: ChangeRow) => {
          await done(c.id, to);
          await patchSnapshot(shop, c, target(c, dir));
        };
        try {
          await setAlts(ctx, good.map((c) => ({ id: c.mediaId!, alt: target(c, dir) })));
          for (const c of good) await finish(c);
        } catch {
          // Shopify refused something in the group: try one by one so the error lands on the right image
          for (const c of good) {
            try {
              await setAlt(ctx, c.mediaId!, target(c, dir));
              await finish(c);
            } catch (e) {
              await fail(c.id, String((e as Error)?.message ?? e));
            }
          }
        }
      } catch (e) {
        for (const c of alts) await fail(c.id, String((e as Error)?.message ?? e)).catch(() => undefined);
      }
    }

    for (const [productId, list] of seo) {
      try {
        const live = await liveSeo(ctx, productId);
        if (!live) {
          for (const c of list) await fail(c.id, "The product no longer exists in Shopify.");
          continue;
        }
        let title = live.seoTitle;
        let desc = live.seoDescription;
        const ok: ChangeRow[] = [];
        for (const c of list) {
          const cur = c.kind === "seoTitle" ? live.seoTitle : live.seoDescription;
          if (cleanText(cur) !== cleanText(expected(c, dir))) {
            await fail(c.id, dir === "apply" ? "Changed in Shopify after the preview. Nothing was overwritten." : "Changed again after it was applied. Not restored.");
            continue;
          }
          if (c.kind === "seoTitle") title = target(c, dir);
          else desc = target(c, dir);
          ok.push(c);
        }
        if (!ok.length) continue;
        await setProductSeo(ctx, productId, title, desc);
        for (const c of ok) {
          await done(c.id, to);
          await patchSnapshot(shop, c, target(c, dir));
        }
      } catch (e) {
        for (const c of list) await fail(c.id, String((e as Error)?.message ?? e)).catch(() => undefined);
      }
    }

    const p = (await batchProgress(shop, batchId))!;
    const left = await prisma.seoChange.count({ where: { batchId, status: from } });
    if (left === 0) {
      await prisma.seoBatch.update({ where: { id: batchId }, data: dir === "apply" ? { status: "done", appliedAt: new Date() } : { status: "restored" } });
      await reaudit(shop);
      return { ...p, status: dir === "apply" ? "done" : "restored" };
    }
    return p;
  } finally {
    busy.delete(batchId);
  }
}

export const applyStep = (shop: string, ctx: Ctx, batchId: string, limit = 25) => step(shop, ctx, batchId, "apply", limit);
export const undoStep = (shop: string, ctx: Ctx, batchId: string, limit = 25) => step(shop, ctx, batchId, "undo", limit);

/** Failed changes go back to "waiting" so Apply can try them again. */
export async function retryFailed(shop: string, batchId: string) {
  const b = await prisma.seoBatch.findFirst({ where: { id: batchId, shop } });
  if (!b) throw new Error("Batch not found.");
  await prisma.seoChange.updateMany({ where: { batchId, status: "failed" }, data: { status: "pending", error: null } });
  if (b.status === "done") await prisma.seoBatch.update({ where: { id: batchId }, data: { status: "applying" } });
}

export async function discardBatch(shop: string, batchId: string) {
  const b = await prisma.seoBatch.findFirst({ where: { id: batchId, shop } });
  if (!b) return;
  const applied = await prisma.seoChange.count({ where: { batchId, status: "applied" } });
  if (applied > 0) throw new Error("This batch already changed your store. Undo it first.");
  await prisma.seoBatch.delete({ where: { id: batchId } });
}

/**
 * Applies (or undoes) a whole batch on the server, in the background. The page only watches the progress, so closing or
 * reloading the page does not stop it. Returns at once; `done` finishes when the batch is finished (tests wait for it).
 */
export async function startRun(shop: string, ctx: Ctx, batchId: string, dir: Dir): Promise<{ started: boolean; done: Promise<void> }> {
  const b = await prisma.seoBatch.findFirst({ where: { id: batchId, shop } });
  if (!b) throw new Error("Batch not found.");
  if (dir === "apply" && b.status === "restored") throw new Error("This batch was already undone.");
  if (runs.has(batchId)) return { started: false, done: Promise.resolve() };
  runs.add(batchId);
  const done = (async () => {
    try {
      let lastLeft = -1;
      let stuck = 0;
      for (let i = 0; i < 5000; i++) {
        const p = dir === "apply" ? await step(shop, ctx, batchId, "apply", 100) : await step(shop, ctx, batchId, "undo", 100);
        const left = dir === "apply" ? p.pending : p.applied;
        if (left === 0) break;
        stuck = left === lastLeft ? stuck + 1 : 0;
        if (stuck >= 3) break; // nothing moves any more: stop instead of looping forever
        lastLeft = left;
      }
    } finally {
      runs.delete(batchId);
    }
  })();
  return { started: true, done };
}

export const isRunning = (batchId: string) => runs.has(batchId);
