/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import prisma from "../../db.server";
import { logEvent } from "../log.server";
import { gql } from "../shopify-data.server";
import { buildIndex, matchCatalog, type CatalogItem } from "./match";
import { linkKey, num } from "./parse";
import { runScrape, type ScrapedProduct } from "./scrapers.server";

export const FINDER_DIR = path.resolve(process.env.FINDER_MEDIA_DIR || ".finder-media");

export type StartParams = {
  category: string; brand: string; mode: string; site: string;
  minPrice: number | null; maxPrice: number | null; maxProducts: number; maxPages: number; skipEarlier: boolean;
};

const g = globalThis as unknown as { __finder?: { active: Map<string, { stop: boolean }> } };
const state = (g.__finder ??= { active: new Map() });

export const isRunning = (id: string) => state.active.has(id);

/** Runs that were "running" when the server stopped can never finish: mark them so the page doesn't wait forever. */
export async function markInterrupted(shop: string) {
  const stale = await prisma.finderRun.findMany({ where: { shop, status: "running" }, select: { id: true } });
  const dead = stale.filter((r) => !state.active.has(r.id)).map((r) => r.id);
  if (dead.length) await prisma.finderRun.updateMany({ where: { id: { in: dead } }, data: { status: "error", error: "Interrupted: the server restarted.", finishedAt: new Date() } });
}

/** Prisma: parent row missing (P2003) or record to update not found (P2025). */
const isGone = (e: unknown) => ["P2003", "P2025"].includes((e as { code?: string })?.code ?? "");

// eslint-disable-next-line no-control-regex
const safeName = (t: string) => t.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 70).trim() || "product";

const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };

async function fetchImage(url: string, referer: string): Promise<{ buf: Buffer; ext: string } | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer }, signal: AbortSignal.timeout(30_000) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !EXT[type]) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 1500 && buf.length < 20 * 1024 * 1024 ? { buf, ext: EXT[type] } : null;
  } catch {
    return null;
  }
}

/** Saves up to 12 images as 1.jpg, 2.jpg ... (6 at a time, duplicates dropped). Returns the saved file names. */
async function downloadImages(urls: string[], dir: string, referer: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const list = urls.slice(0, 12);
  const got: ({ buf: Buffer; ext: string } | null)[] = new Array(list.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < list.length) {
        const i = next++;
        got[i] = await fetchImage(list[i], referer);
      }
    }),
  );
  const saved: string[] = [];
  const seen = new Set<string>();
  for (const item of got) {
    if (!item) continue;
    const h = createHash("sha1").update(item.buf).digest("hex");
    if (seen.has(h)) continue;
    seen.add(h);
    const name = `${saved.length + 1}${item.ext}`;
    writeFileSync(path.join(dir, name), item.buf);
    saved.push(name);
  }
  return saved;
}

/** The merchant's whole Shopify catalog (title, handle, vendor, SKUs, barcodes) for the "already in my store" check. */
export async function loadCatalog(shop: string, onPage?: (n: number) => void): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  let after: string | null = null;
  for (let page = 1; page <= 100; page++) {
    const data: any = await gql(
      shop,
      `query($after: String) { products(first: 100, after: $after) {
        nodes { id title handle vendor variants(first: 50) { nodes { sku barcode } } }
        pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    for (const p of data.products?.nodes ?? []) {
      const v: any[] = p.variants?.nodes ?? [];
      out.push({ id: p.id, title: p.title, handle: p.handle, vendor: p.vendor ?? "", skus: v.map((x) => x.sku).filter(Boolean), barcodes: v.map((x) => x.barcode).filter(Boolean) });
    }
    onPage?.(out.length);
    const info = data.products?.pageInfo;
    if (!info?.hasNextPage) break;
    after = info.endCursor;
  }
  return out;
}

export async function startRun(shop: string, p: StartParams): Promise<string> {
  if (state.active.size > 0) throw new Error("A search is already running. Wait for it to finish or stop it.");
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  await prisma.finderRun.create({
    data: {
      id, shop, category: p.category, brand: p.brand, mode: p.mode, site: p.site, minPrice: p.minPrice, maxPrice: p.maxPrice,
      maxProducts: p.maxProducts, maxPages: p.maxPages, skipEarlier: p.skipEarlier, log: JSON.stringify(["Starting…"]),
    },
  });
  const flag = { stop: false };
  state.active.set(id, flag);
  void execute(shop, id, p, flag).finally(() => state.active.delete(id));
  return id;
}

export function stopRun(id: string) {
  const f = state.active.get(id);
  if (f) f.stop = true;
  return !!f;
}

async function execute(shop: string, id: string, p: StartParams, flag: { stop: boolean }) {
  const lines: string[] = ["Starting…"];
  let checked = 0;
  let skippedInStore = 0;
  let skippedEarlier = 0;
  let last = 0;
  const flush = async (force = false) => {
    if (!force && Date.now() - last < 1000) return;
    last = Date.now();
    await prisma.finderRun.update({ where: { id }, data: { log: JSON.stringify(lines.slice(-150)), checked, skippedInStore, skippedEarlier } }).catch(() => undefined);
  };
  const log = (m: string) => {
    lines.push(m);
    void flush();
  };

  try {
    log("Reading your Shopify catalog to skip products you already have…");
    const catalog = await loadCatalog(shop, (n) => n % 500 === 0 && log(`Read ${n} products from your store`));
    const index = buildIndex(catalog);
    log(`Your store has ${catalog.length} products. Searching now…`);

    const earlier = new Set<string>();
    if (p.skipEarlier) {
      for (const r of await prisma.finderProduct.findMany({ where: { shop }, select: { linkKey: true }, take: 100_000 })) earlier.add(r.linkKey);
    }
    // If the search was deleted while it runs, its row is gone: stop quietly instead of failing with a database error.
    const save = async (data: Parameters<typeof prisma.finderProduct.create>[0]["data"]) => {
      try {
        await prisma.finderProduct.create({ data });
        return true;
      } catch (e) {
        if (isGone(e)) {
          flag.stop = true;
          return false;
        }
        throw e;
      }
    };
    const seenNow = new Set<string>();
    const runDir = path.join(FINDER_DIR, id);
    const usedFolders = new Set<string>();

    const emit = async (prod: ScrapedProduct): Promise<boolean> => {
      const price = num(prod.price);
      if ((p.minPrice !== null || p.maxPrice !== null) && price === null) return false;
      if ((p.minPrice !== null && price! < p.minPrice) || (p.maxPrice !== null && price! > p.maxPrice)) return false; // outside the price range
      const key = linkKey(prod.link);
      if (seenNow.has(key)) return false;
      seenNow.add(key);
      if (earlier.has(key)) {
        skippedEarlier++;
        return false;
      }
      const compare = num(prod.comparePrice);
      const discount = price && compare && compare > price ? Math.round(((compare - price) / compare) * 100) : 0;
      const base = { runId: id, shop, title: prod.title, brand: prod.brand, price: prod.price, comparePrice: discount ? prod.comparePrice : "", discount, link: prod.link, linkKey: key };

      const hit = matchCatalog(index, { title: prod.title, brand: prod.brand, skus: prod.skus, barcodes: prod.barcodes });
      if (hit) {
        skippedInStore++;
        log(`Already in your store, skipped: ${prod.title.slice(0, 50)}`);
        await save({ ...base, isNew: false, matchReason: `${hit.reason}: ${hit.title}`.slice(0, 200) });
        return false;
      }

      let folder = safeName(prod.title);
      for (let n = 2; usedFolders.has(folder.toLowerCase()); n++) folder = `${safeName(prod.title)} (${n})`;
      usedFolders.add(folder.toLowerCase());
      log(`New product, downloading images: ${prod.title.slice(0, 50)}`);
      const files = await downloadImages(prod.images, path.join(runDir, folder), prod.link);
      if (!(await save({ ...base, isNew: true, imageCount: files.length, folder, thumb: files[0] ? `${folder}/${files[0]}` : "" }))) return false;
      return true;
    };

    await runScrape(
      { mode: p.mode, site: p.site, category: p.category, brand: p.brand, limit: p.maxProducts, pages: p.maxPages },
      { log, checked: (n) => { checked = n; void flush(); }, emit, stopped: () => flag.stop },
    );
    const total = await prisma.finderProduct.count({ where: { runId: id, isNew: true } });
    log(flag.stop ? `Stopped. ${total} new products saved.` : `Finished: ${total} new products saved, ${skippedInStore} already in your store were skipped.`);
    await flush(true);
    await prisma.finderRun.update({ where: { id }, data: { status: flag.stop ? "stopped" : "done", finishedAt: new Date() } });
  } catch (e) {
    if (isGone(e)) return; // the search was deleted while it ran
    const msg = (e as Error).message;
    lines.push(`Error: ${msg}`);
    await flush(true);
    await prisma.finderRun.update({ where: { id }, data: { status: "error", error: msg.slice(0, 300), finishedAt: new Date() } }).catch(() => undefined);
    await logEvent({ shop, source: "shopify", level: "error", event: "finder_failed", detail: msg });
  }
}
